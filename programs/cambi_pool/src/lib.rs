//! cambI pool: casa de câmbio on-chain (real digital <-> dólar digital) em que
//! quem deposita recebe parte das taxas de cada troca.
//!
//! Versão de hackathon. Simplificações conhecidas (ver docs/ARCHITECTURE.md):
//! - o preço vem de uma autoridade de oráculo (em produção: Pyth/Switchboard);
//! - as taxas de uma troca vão para quem depositou a moeda que ENTROU nessa troca;
//! - a proteção da camada Rende pela Baleia (perdas de desequilíbrio) ainda não está on-chain;
//! - a parte "aplicada" em renda fixa (CDI / T-bill tokenizado) é roadmap.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// ID de exemplo: substitua pelo endereço gerado em `anchor keys sync` antes do deploy.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const PRICE_SCALE: u128 = 1_000_000; // preço = reais por dólar * 1e6
pub const ACC_SCALE: u128 = 1_000_000_000_000; // escala do acumulador de taxas
pub const BPS: u128 = 10_000;

#[program]
pub mod cambi_pool {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, price: u64, max_price_age: i64) -> Result<()> {
        require!(price > 0, CambiError::InvalidPrice);
        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.oracle = ctx.accounts.admin.key();
        pool.brl_mint = ctx.accounts.brl_mint.key();
        pool.usd_mint = ctx.accounts.usd_mint.key();
        pool.price = price;
        pool.price_updated_at = Clock::get()?.unix_timestamp;
        pool.max_price_age = max_price_age;
        pool.fees = FeeConfig::default();
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Atualiza a cotação (reais por dólar, escala 1e6). Só a autoridade de oráculo.
    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        require!(price > 0, CambiError::InvalidPrice);
        let pool = &mut ctx.accounts.pool;
        pool.price = price;
        pool.price_updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn add_partner(ctx: Context<AddPartner>) -> Result<()> {
        let p = &mut ctx.accounts.partner;
        p.pool = ctx.accounts.pool.key();
        p.authority = ctx.accounts.partner_authority.key();
        p.bump = ctx.bumps.partner;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, tranche: u8, side: u8, amount: u64) -> Result<()> {
        require!(amount > 0, CambiError::ZeroAmount);
        let t = Tranche::try_from(tranche)?;
        let s = Side::try_from(side)?;
        check_vault(&ctx.accounts.pool, &ctx.accounts.vault, s)?;

        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.pool = pool.key();
            pos.tranche = tranche;
            pos.side = side;
            pos.bump = ctx.bumps.position;
        }

        let pending = harvest(pool, pos, t, s)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        pos.amount = pos.amount.checked_add(amount).ok_or(CambiError::MathOverflow)?;
        let i = idx(t, s);
        pool.deposits[i] = pool.deposits[i].checked_add(amount).ok_or(CambiError::MathOverflow)?;
        pos.reward_debt = mul_acc(pos.amount, pool.acc_fee_per_share[i])?;

        // Taxas pendentes ficam no saldo do usuário via transferência separada (harvest).
        if pending > 0 {
            pay_from_vault(&ctx.accounts.pool, &ctx.accounts.vault, &ctx.accounts.user_token, &ctx.accounts.token_program, pending)?;
        }
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let t = Tranche::try_from(ctx.accounts.position.tranche)?;
        let s = Side::try_from(ctx.accounts.position.side)?;
        check_vault(&ctx.accounts.pool, &ctx.accounts.vault, s)?;
        require!(amount <= ctx.accounts.position.amount, CambiError::InsufficientPosition);

        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        let pending = harvest(pool, pos, t, s)?;

        let i = idx(t, s);
        pos.amount -= amount;
        pool.deposits[i] -= amount;
        pos.reward_debt = mul_acc(pos.amount, pool.acc_fee_per_share[i])?;

        let total = amount.checked_add(pending).ok_or(CambiError::MathOverflow)?;
        require!(
            available(&ctx.accounts.pool, ctx.accounts.vault.amount, s) + pending >= total,
            CambiError::InsufficientLiquidity
        );
        pay_from_vault(&ctx.accounts.pool, &ctx.accounts.vault, &ctx.accounts.user_token, &ctx.accounts.token_program, total)?;
        Ok(())
    }

    /// Troca `amount_in` da moeda `side_in` pela outra moeda, ao preço do oráculo.
    /// O tipo de cliente é provado por contas opcionais:
    /// - `depositor_position` com saldo do próprio usuário => taxa de depositante;
    /// - `partner` registrado para o usuário => taxa B2B;
    /// - nenhum => taxa de varejo.
    pub fn swap(ctx: Context<Swap>, side_in: u8, amount_in: u64, min_out: u64) -> Result<()> {
        require!(amount_in > 0, CambiError::ZeroAmount);
        let s_in = Side::try_from(side_in)?;
        let s_out = s_in.other();
        let pool_key = ctx.accounts.pool.key();
        let user_key = ctx.accounts.user.key();

        let (vault_in, vault_out) = match s_in {
            Side::Brl => (&ctx.accounts.brl_vault, &ctx.accounts.usd_vault),
            Side::Usd => (&ctx.accounts.usd_vault, &ctx.accounts.brl_vault),
        };
        let (user_in, user_out) = match s_in {
            Side::Brl => (&ctx.accounts.user_brl, &ctx.accounts.user_usd),
            Side::Usd => (&ctx.accounts.user_usd, &ctx.accounts.user_brl),
        };

        let pool = &ctx.accounts.pool;
        let now = Clock::get()?.unix_timestamp;
        require!(now - pool.price_updated_at <= pool.max_price_age, CambiError::StalePrice);

        let kind = if let Some(p) = &ctx.accounts.partner {
            require!(p.authority == user_key && p.pool == pool_key, CambiError::InvalidPartner);
            UserKind::B2b
        } else if let Some(pos) = &ctx.accounts.depositor_position {
            require!(pos.owner == user_key && pos.pool == pool_key && pos.amount > 0, CambiError::InvalidPosition);
            UserKind::Depositor
        } else {
            UserKind::Retail
        };

        let brl_avail = available(pool, ctx.accounts.brl_vault.amount, Side::Brl);
        let usd_avail = available(pool, ctx.accounts.usd_vault.amount, Side::Usd);
        let q = quote(pool, s_in, amount_in, kind, brl_avail, usd_avail)?;
        require!(q.amount_out >= min_out, CambiError::SlippageExceeded);
        let out_avail = match s_out {
            Side::Brl => brl_avail,
            Side::Usd => usd_avail,
        };
        require!(q.amount_out <= out_avail, CambiError::InsufficientLiquidity);

        // Entra o valor do usuário.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: user_in.to_account_info(),
                    to: vault_in.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_in,
        )?;
        // Sai a outra moeda.
        pay_from_vault(pool, vault_out, user_out, &ctx.accounts.token_program, q.amount_out)?;

        // Contabiliza a divisão da taxa (os tokens da taxa ficam no cofre de entrada).
        let pool = &mut ctx.accounts.pool;
        let si = s_in as usize;
        pool.partner_fees[si] += q.to_partner;
        pool.platform_fees[si] += q.to_platform;
        for (t, share) in [(Tranche::Rende, q.to_rende), (Tranche::Baleia, q.to_baleia)] {
            let i = idx(t, s_in);
            if pool.deposits[i] == 0 {
                pool.platform_fees[si] += share; // sem depositantes nessa camada: vai para a operação
            } else {
                pool.lp_fees_unclaimed[si] += share;
                let inc = (share as u128) * ACC_SCALE / (pool.deposits[i] as u128);
                pool.acc_fee_per_share[i] = pool.acc_fee_per_share[i].checked_add(inc).ok_or(CambiError::MathOverflow)?;
            }
        }
        pool.swap_count += 1;

        emit!(SwapEvent {
            user: user_key,
            side_in,
            amount_in,
            amount_out: q.amount_out,
            fee: q.fee,
            to_rende: q.to_rende,
            to_baleia: q.to_baleia,
            to_platform: q.to_platform,
            to_partner: q.to_partner,
            price: pool.price,
        });
        Ok(())
    }

    /// Admin retira as taxas da operação e do parceiro regulado de uma moeda.
    pub fn collect_fees(ctx: Context<CollectFees>, side: u8) -> Result<()> {
        let s = Side::try_from(side)?;
        check_vault(&ctx.accounts.pool, &ctx.accounts.vault, s)?;
        let si = s as usize;
        let amount = ctx.accounts.pool.platform_fees[si] + ctx.accounts.pool.partner_fees[si];
        require!(amount > 0, CambiError::ZeroAmount);
        pay_from_vault(&ctx.accounts.pool, &ctx.accounts.vault, &ctx.accounts.destination, &ctx.accounts.token_program, amount)?;
        let pool = &mut ctx.accounts.pool;
        pool.platform_fees[si] = 0;
        pool.partner_fees[si] = 0;
        Ok(())
    }
}

// ---------- lógica pura (testável sem a Solana) ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Brl = 0,
    Usd = 1,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Brl => Side::Usd,
            Side::Usd => Side::Brl,
        }
    }
}

impl TryFrom<u8> for Side {
    type Error = Error;
    fn try_from(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Side::Brl),
            1 => Ok(Side::Usd),
            _ => err!(CambiError::InvalidSide),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tranche {
    Rende = 0,
    Baleia = 1,
}

impl TryFrom<u8> for Tranche {
    type Error = Error;
    fn try_from(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Tranche::Rende),
            1 => Ok(Tranche::Baleia),
            _ => err!(CambiError::InvalidTranche),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UserKind {
    Depositor,
    Retail,
    B2b,
}

pub fn idx(t: Tranche, s: Side) -> usize {
    (t as usize) * 2 + (s as usize)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Quote {
    pub fee: u64,
    pub amount_out: u64,
    pub to_partner: u64,
    pub to_platform: u64,
    pub to_baleia: u64,
    pub to_rende: u64,
}

/// Calcula a troca. `brl_avail`/`usd_avail` são os saldos líquidos (6 casas decimais).
pub fn quote(pool: &Pool, s_in: Side, amount_in: u64, kind: UserKind, brl_avail: u64, usd_avail: u64) -> Result<Quote> {
    let f = &pool.fees;
    let base_bps = match kind {
        UserKind::Depositor => f.depositor_bps,
        UserKind::Retail => f.retail_bps,
        UserKind::B2b => f.b2b_bps,
    } as u128;
    let pix_bps = match kind {
        UserKind::Depositor => f.depositor_pix_bps,
        UserKind::Retail => f.retail_pix_bps,
        UserKind::B2b => f.b2b_pix_bps,
    } as u128;

    // Desequilíbrio em bps (-10000..10000): positivo = sobra real.
    let price = pool.price as u128;
    let brl = brl_avail as u128;
    let usd_in_brl = (usd_avail as u128) * price / PRICE_SCALE;
    let total = brl + usd_in_brl;
    let imb: i128 = if total == 0 { 0 } else { ((brl as i128) - (usd_in_brl as i128)) * (BPS as i128) / (total as i128) };
    let worsens = match s_in {
        Side::Brl => imb,
        Side::Usd => -imb,
    };
    let mult = (BPS as i128 + worsens).clamp(f.dynamic_min_bps as i128, f.dynamic_max_bps as i128) as u128;
    let fee_bps = base_bps * mult / BPS;

    let amount = amount_in as u128;
    let fee = amount * fee_bps / BPS;
    let net = amount - fee;
    let amount_out = match s_in {
        Side::Brl => net * PRICE_SCALE / price,
        Side::Usd => net * price / PRICE_SCALE,
    };

    let to_partner = (amount * pix_bps * (f.partner_cost_bps as u128) / BPS / BPS).min(fee);
    let after_partner = fee - to_partner;
    let to_platform = after_partner * (f.platform_share_bps as u128) / BPS;
    let lp = after_partner - to_platform;
    let to_baleia = lp * (f.baleia_share_bps as u128) / BPS;
    let to_rende = lp - to_baleia;

    let c = |v: u128| u64::try_from(v).map_err(|_| error!(CambiError::MathOverflow));
    Ok(Quote {
        fee: c(fee)?,
        amount_out: c(amount_out)?,
        to_partner: c(to_partner)?,
        to_platform: c(to_platform)?,
        to_baleia: c(to_baleia)?,
        to_rende: c(to_rende)?,
    })
}

/// Saldo do cofre que pode ser usado em trocas (exclui taxas reservadas).
pub fn available(pool: &Pool, vault_amount: u64, s: Side) -> u64 {
    let si = s as usize;
    let reserved = pool.platform_fees[si] + pool.partner_fees[si] + pool.lp_fees_unclaimed[si];
    vault_amount.saturating_sub(reserved)
}

fn mul_acc(amount: u64, acc: u128) -> Result<u128> {
    (amount as u128)
        .checked_mul(acc)
        .map(|v| v / ACC_SCALE)
        .ok_or(error!(CambiError::MathOverflow))
}

fn harvest(pool: &mut Pool, pos: &mut Position, t: Tranche, s: Side) -> Result<u64> {
    let accrued = mul_acc(pos.amount, pool.acc_fee_per_share[idx(t, s)])?;
    let pending = u64::try_from(accrued.saturating_sub(pos.reward_debt)).map_err(|_| error!(CambiError::MathOverflow))?;
    let si = s as usize;
    pool.lp_fees_unclaimed[si] = pool.lp_fees_unclaimed[si].saturating_sub(pending);
    Ok(pending)
}

fn check_vault(pool: &Pool, vault: &TokenAccount, s: Side) -> Result<()> {
    let mint = match s {
        Side::Brl => pool.brl_mint,
        Side::Usd => pool.usd_mint,
    };
    require_keys_eq!(vault.mint, mint, CambiError::WrongVault);
    Ok(())
}

fn pay_from_vault<'info>(
    pool: &Account<'info, Pool>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"pool", pool.brl_mint.as_ref(), pool.usd_mint.as_ref(), &[pool.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: vault.to_account_info(), to: to.to_account_info(), authority: pool.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

// ---------- contas ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug)]
pub struct FeeConfig {
    pub depositor_bps: u16,
    pub retail_bps: u16,
    pub b2b_bps: u16,
    pub depositor_pix_bps: u16,
    pub retail_pix_bps: u16,
    pub b2b_pix_bps: u16,
    pub partner_cost_bps: u16,
    pub platform_share_bps: u16,
    pub baleia_share_bps: u16,
    pub dynamic_min_bps: u16,
    pub dynamic_max_bps: u16,
}

impl Default for FeeConfig {
    fn default() -> Self {
        Self {
            depositor_bps: 50,    // 0,5%
            retail_bps: 100,      // 1,0%
            b2b_bps: 40,          // 0,4%
            depositor_pix_bps: 5_000, // 50% do volume passa pelo Pix
            retail_pix_bps: 10_000,
            b2b_pix_bps: 2_000,
            partner_cost_bps: 20, // 0,2% do volume via Pix
            platform_share_bps: 2_500, // 25% da taxa líquida
            baleia_share_bps: 7_000,   // 70% do que vai para provedores de liquidez
            dynamic_min_bps: 7_000,    // taxa pode cair até 0,7x
            dynamic_max_bps: 15_000,   // ou subir até 1,5x
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub brl_mint: Pubkey,
    pub usd_mint: Pubkey,
    pub price: u64,
    pub price_updated_at: i64,
    pub max_price_age: i64,
    pub fees: FeeConfig,
    /// [rende_brl, rende_usd, baleia_brl, baleia_usd]
    pub deposits: [u64; 4],
    pub acc_fee_per_share: [u128; 4],
    /// por moeda: [brl, usd]
    pub lp_fees_unclaimed: [u64; 2],
    pub platform_fees: [u64; 2],
    pub partner_fees: [u64; 2],
    pub swap_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub tranche: u8,
    pub side: u8,
    pub amount: u64,
    pub reward_debt: u128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Partner {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
}

#[event]
pub struct SwapEvent {
    pub user: Pubkey,
    pub side_in: u8,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
    pub to_rende: u64,
    pub to_baleia: u64,
    pub to_platform: u64,
    pub to_partner: u64,
    pub price: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub brl_mint: Account<'info, Mint>,
    pub usd_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin, space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", brl_mint.key().as_ref(), usd_mint.key().as_ref()], bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init, payer = admin, token::mint = brl_mint, token::authority = pool,
        seeds = [b"vault", pool.key().as_ref(), brl_mint.key().as_ref()], bump
    )]
    pub brl_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = admin, token::mint = usd_mint, token::authority = pool,
        seeds = [b"vault", pool.key().as_ref(), usd_mint.key().as_ref()], bump
    )]
    pub usd_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct AddPartner<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(has_one = admin)]
    pub pool: Account<'info, Pool>,
    /// CHECK: carteira do app parceiro; só usada como chave.
    pub partner_authority: UncheckedAccount<'info>,
    #[account(
        init, payer = admin, space = 8 + Partner::INIT_SPACE,
        seeds = [b"partner", pool.key().as_ref(), partner_authority.key().as_ref()], bump
    )]
    pub partner: Account<'info, Partner>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tranche: u8, side: u8)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref(), &[tranche], &[side]], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::authority = pool)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(mut, constraint = position.owner == user.key() @ CambiError::InvalidPosition, has_one = pool)]
    pub position: Account<'info, Position>,
    #[account(mut, token::authority = pool)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = pool)]
    pub brl_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = pool)]
    pub usd_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Account<'info, TokenAccount>,
    pub depositor_position: Option<Account<'info, Position>>,
    pub partner: Option<Account<'info, Partner>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, token::authority = pool)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum CambiError {
    #[msg("Preço inválido")]
    InvalidPrice,
    #[msg("Cotação desatualizada")]
    StalePrice,
    #[msg("Valor precisa ser maior que zero")]
    ZeroAmount,
    #[msg("Moeda inválida")]
    InvalidSide,
    #[msg("Camada inválida")]
    InvalidTranche,
    #[msg("Cofre não corresponde à moeda")]
    WrongVault,
    #[msg("Liquidez insuficiente no pool")]
    InsufficientLiquidity,
    #[msg("Saldo da posição insuficiente")]
    InsufficientPosition,
    #[msg("Recebido abaixo do mínimo aceito")]
    SlippageExceeded,
    #[msg("Parceiro inválido")]
    InvalidPartner,
    #[msg("Posição inválida")]
    InvalidPosition,
    #[msg("Estouro numérico")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(price: u64) -> Pool {
        Pool {
            admin: Pubkey::default(),
            oracle: Pubkey::default(),
            brl_mint: Pubkey::default(),
            usd_mint: Pubkey::default(),
            price,
            price_updated_at: 0,
            max_price_age: 60,
            fees: FeeConfig::default(),
            deposits: [0; 4],
            acc_fee_per_share: [0; 4],
            lp_fees_unclaimed: [0; 2],
            platform_fees: [0; 2],
            partner_fees: [0; 2],
            swap_count: 0,
            bump: 0,
        }
    }

    const R: u64 = 1_000_000; // 1 unidade com 6 casas

    #[test]
    fn taxa_base_com_pool_equilibrado() {
        let p = pool(5_400_000); // R$ 5,40
        let q = quote(&p, Side::Brl, 5_400 * R, UserKind::Retail, 540_000 * R, 100_000 * R).unwrap();
        assert_eq!(q.fee, 54 * R); // 1%
        assert_eq!(q.amount_out, (5_400 - 54) * R * 1_000_000 / 5_400_000);
    }

    #[test]
    fn divisao_da_taxa_soma_o_total() {
        let p = pool(5_400_000);
        let q = quote(&p, Side::Brl, 10_000 * R, UserKind::Retail, 540_000 * R, 100_000 * R).unwrap();
        assert_eq!(q.to_partner + q.to_platform + q.to_baleia + q.to_rende, q.fee);
        assert!(q.to_baleia > q.to_rende);
    }

    #[test]
    fn depositante_paga_metade() {
        let p = pool(5_400_000);
        let r = quote(&p, Side::Brl, 1_000 * R, UserKind::Retail, 540_000 * R, 100_000 * R).unwrap();
        let d = quote(&p, Side::Brl, 1_000 * R, UserKind::Depositor, 540_000 * R, 100_000 * R).unwrap();
        assert_eq!(d.fee * 2, r.fee);
    }

    #[test]
    fn taxa_dinamica_encarece_quem_desequilibra() {
        let p = pool(5_400_000);
        // Sobra real: 900 mil reais contra 50 mil dólares (270 mil reais).
        let piora = quote(&p, Side::Brl, 1_000 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap();
        let melhora = quote(&p, Side::Usd, 185 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap();
        assert!(piora.fee > 10 * R); // acima de 1%
        assert!(melhora.fee * 100 < 185 * R); // abaixo de 1%
    }

    #[test]
    fn available_desconta_taxas_reservadas() {
        let mut p = pool(5_400_000);
        p.platform_fees[0] = 10;
        p.partner_fees[0] = 5;
        p.lp_fees_unclaimed[0] = 20;
        assert_eq!(available(&p, 100, Side::Brl), 65);
    }
}
