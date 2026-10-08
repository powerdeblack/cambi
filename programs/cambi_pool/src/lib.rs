//! cambI pool: casa de câmbio on-chain (real digital <-> dólar digital) em que
//! quem deposita recebe parte das taxas de cada troca.
//!
//! Regras principais (detalhes em docs/ARQUITETURA.md):
//! - troca ao preço do oráculo, recusada se a cotação estiver velha;
//! - taxa dinâmica: mais cara no sentido que desequilibra o pool;
//! - taxas divididas entre parceiro regulado, operação, Baleia e Rende;
//! - cada camada recebe taxas nas DUAS moedas, proporcional ao VALOR depositado (shares);
//! - a Rende é sênior: a Baleia só saca se o cofre continuar cobrindo todo o principal da Rende;
//! - limite por troca e pausa de emergência (saques continuam liberados durante a pausa).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ");

pub const PRICE_SCALE: u128 = 1_000_000; // preço = reais por dólar * 1e6
pub const ACC_SCALE: u128 = 1_000_000_000_000; // escala do acumulador de taxas por share
pub const BPS: u128 = 10_000;

pub const BRL: usize = 0;
pub const USD: usize = 1;
pub const RENDE: usize = 0;
pub const BALEIA: usize = 1;

#[program]
pub mod cambi_pool {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, price: u64, max_price_age: i64) -> Result<()> {
        require!(price > 0, CambiError::InvalidPrice);
        require!(max_price_age > 0, CambiError::InvalidConfig);
        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.oracle = ctx.accounts.admin.key();
        pool.brl_mint = ctx.accounts.brl_mint.key();
        pool.usd_mint = ctx.accounts.usd_mint.key();
        pool.brl_vault = ctx.accounts.brl_vault.key();
        pool.usd_vault = ctx.accounts.usd_vault.key();
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

    pub fn set_oracle(ctx: Context<AdminOnly>, oracle: Pubkey) -> Result<()> {
        ctx.accounts.pool.oracle = oracle;
        Ok(())
    }

    /// Pausa trocas e depósitos. Saques continuam liberados para ninguém ficar preso.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.pool.paused = paused;
        Ok(())
    }

    pub fn update_fees(ctx: Context<AdminOnly>, fees: FeeConfig) -> Result<()> {
        fees.validate()?;
        ctx.accounts.pool.fees = fees;
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
        require!(!ctx.accounts.pool.paused, CambiError::Paused);
        let t = tranche_idx(tranche)?;
        let s = side_idx(side)?;

        let pending = {
            let pool = &mut ctx.accounts.pool;
            let pos = &mut ctx.accounts.position;
            if pos.owner == Pubkey::default() {
                pos.owner = ctx.accounts.user.key();
                pos.pool = pool.key();
                pos.tranche = tranche;
                pos.side = side;
                pos.bump = ctx.bumps.position;
            }
            let pending = harvest(pool, pos)?;
            let added = value_in_brl(pool.price, s, amount)?;
            pos.amount = pos.amount.checked_add(amount).ok_or(CambiError::MathOverflow)?;
            pos.shares = pos.shares.checked_add(added).ok_or(CambiError::MathOverflow)?;
            pool.shares[t] = pool.shares[t].checked_add(added).ok_or(CambiError::MathOverflow)?;
            let i = idx(t, s);
            pool.principal[i] = pool.principal[i].checked_add(amount).ok_or(CambiError::MathOverflow)?;
            sync_debt(pool, pos);
            pending
        };

        let (from, to) = match s {
            BRL => (&ctx.accounts.user_brl, &ctx.accounts.brl_vault),
            _ => (&ctx.accounts.user_usd, &ctx.accounts.usd_vault),
        };
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
        pay_pending(
            &ctx.accounts.pool,
            [&ctx.accounts.brl_vault, &ctx.accounts.usd_vault],
            [&ctx.accounts.user_brl, &ctx.accounts.user_usd],
            &ctx.accounts.token_program,
            pending,
        )?;

        emit!(DepositEvent { user: ctx.accounts.user.key(), tranche, side, amount });
        Ok(())
    }

    /// Saca principal da posição (na moeda depositada) e recebe as taxas acumuladas nas duas moedas.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let t = tranche_idx(ctx.accounts.position.tranche)?;
        let s = side_idx(ctx.accounts.position.side)?;
        require!(amount <= ctx.accounts.position.amount, CambiError::InsufficientPosition);

        let vault_amount = match s {
            BRL => ctx.accounts.brl_vault.amount,
            _ => ctx.accounts.usd_vault.amount,
        };
        let avail = available(&ctx.accounts.pool, vault_amount, s);
        require!(amount <= avail, CambiError::InsufficientLiquidity);
        if t == BALEIA {
            // A Rende é sênior: depois do saque, o cofre ainda precisa cobrir todo o principal da Rende.
            require!(
                baleia_can_withdraw(avail, amount, ctx.accounts.pool.principal[idx(RENDE, s)]),
                CambiError::BaleiaJuniorLiquidity
            );
        }

        let pending = {
            let pool = &mut ctx.accounts.pool;
            let pos = &mut ctx.accounts.position;
            let pending = harvest(pool, pos)?;
            let removed = if pos.amount == 0 {
                0
            } else {
                pos.shares * (amount as u128) / (pos.amount as u128)
            };
            pos.amount -= amount;
            pos.shares -= removed;
            pool.shares[t] -= removed;
            pool.principal[idx(t, s)] -= amount;
            sync_debt(pool, pos);
            pending
        };

        let (vault, dest) = match s {
            BRL => (&ctx.accounts.brl_vault, &ctx.accounts.user_brl),
            _ => (&ctx.accounts.usd_vault, &ctx.accounts.user_usd),
        };
        if amount > 0 {
            pay_from_vault(&ctx.accounts.pool, vault, dest, &ctx.accounts.token_program, amount)?;
        }
        pay_pending(
            &ctx.accounts.pool,
            [&ctx.accounts.brl_vault, &ctx.accounts.usd_vault],
            [&ctx.accounts.user_brl, &ctx.accounts.user_usd],
            &ctx.accounts.token_program,
            pending,
        )?;

        emit!(WithdrawEvent { user: ctx.accounts.user.key(), tranche: t as u8, side: s as u8, amount, fees: pending });
        Ok(())
    }

    /// Troca `amount_in` da moeda `side_in` pela outra moeda, ao preço do oráculo.
    /// O tipo de cliente é provado por contas opcionais:
    /// - `depositor_position` com saldo do próprio usuário => taxa de depositante;
    /// - `partner` registrado para o usuário => taxa B2B;
    /// - nenhum => taxa de varejo.
    pub fn swap(ctx: Context<Swap>, side_in: u8, amount_in: u64, min_out: u64) -> Result<()> {
        require!(amount_in > 0, CambiError::ZeroAmount);
        let s_in = side_idx(side_in)?;
        let s_out = 1 - s_in;
        let user_key = ctx.accounts.user.key();
        let pool_key = ctx.accounts.pool.key();

        let q = {
            let pool = &ctx.accounts.pool;
            require!(!pool.paused, CambiError::Paused);
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

            let avail = [
                available(pool, ctx.accounts.brl_vault.amount, BRL),
                available(pool, ctx.accounts.usd_vault.amount, USD),
            ];
            let q = quote(pool, s_in, amount_in, kind, avail[BRL], avail[USD])?;
            require!(q.amount_out > 0, CambiError::ZeroAmount);
            require!(q.amount_out >= min_out, CambiError::SlippageExceeded);
            require!(q.amount_out <= avail[s_out], CambiError::InsufficientLiquidity);
            let max_out = (avail[s_out] as u128) * (pool.fees.max_trade_bps as u128) / BPS;
            require!((q.amount_out as u128) <= max_out, CambiError::TradeTooLarge);
            q
        };

        let (vault_in, vault_out, user_in, user_out) = match s_in {
            BRL => (&ctx.accounts.brl_vault, &ctx.accounts.usd_vault, &ctx.accounts.user_brl, &ctx.accounts.user_usd),
            _ => (&ctx.accounts.usd_vault, &ctx.accounts.brl_vault, &ctx.accounts.user_usd, &ctx.accounts.user_brl),
        };
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
        pay_from_vault(&ctx.accounts.pool, vault_out, user_out, &ctx.accounts.token_program, q.amount_out)?;

        // Contabiliza a divisão da taxa (os tokens da taxa ficam no cofre de entrada, reservados).
        let pool = &mut ctx.accounts.pool;
        pool.partner_fees[s_in] += q.to_partner;
        pool.platform_fees[s_in] += q.to_platform;
        for (t, share) in [(RENDE, q.to_rende), (BALEIA, q.to_baleia)] {
            if pool.shares[t] == 0 {
                pool.platform_fees[s_in] += share; // camada vazia: vai para a operação
            } else {
                pool.lp_fees_unclaimed[s_in] += share;
                let inc = (share as u128) * ACC_SCALE / pool.shares[t];
                let i = idx(t, s_in);
                pool.acc_fee_per_share[i] = pool.acc_fee_per_share[i].checked_add(inc).ok_or(CambiError::MathOverflow)?;
            }
        }
        pool.swap_count += 1;
        pool.volume_brl = pool.volume_brl.saturating_add(value_in_brl(pool.price, s_in, amount_in)? as u64);

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
        let s = side_idx(side)?;
        let expected = if s == BRL { ctx.accounts.pool.brl_vault } else { ctx.accounts.pool.usd_vault };
        require_keys_eq!(ctx.accounts.vault.key(), expected, CambiError::WrongVault);
        let amount = ctx.accounts.pool.platform_fees[s] + ctx.accounts.pool.partner_fees[s];
        require!(amount > 0, CambiError::ZeroAmount);
        pay_from_vault(&ctx.accounts.pool, &ctx.accounts.vault, &ctx.accounts.destination, &ctx.accounts.token_program, amount)?;
        let pool = &mut ctx.accounts.pool;
        pool.platform_fees[s] = 0;
        pool.partner_fees[s] = 0;
        Ok(())
    }
}

// ---------- lógica pura (testável sem a Solana) ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UserKind {
    Depositor,
    Retail,
    B2b,
}

pub fn side_idx(v: u8) -> Result<usize> {
    match v {
        0 => Ok(BRL),
        1 => Ok(USD),
        _ => err!(CambiError::InvalidSide),
    }
}

pub fn tranche_idx(v: u8) -> Result<usize> {
    match v {
        0 => Ok(RENDE),
        1 => Ok(BALEIA),
        _ => err!(CambiError::InvalidTranche),
    }
}

/// Índice em arrays [rende_brl, rende_usd, baleia_brl, baleia_usd].
pub fn idx(t: usize, s: usize) -> usize {
    t * 2 + s
}

/// Valor em reais (6 casas) de um montante. Usado como "shares" das camadas.
pub fn value_in_brl(price: u64, s: usize, amount: u64) -> Result<u128> {
    if s == BRL {
        Ok(amount as u128)
    } else {
        (amount as u128)
            .checked_mul(price as u128)
            .map(|v| v / PRICE_SCALE)
            .ok_or(error!(CambiError::MathOverflow))
    }
}

/// A Baleia só pode sacar se, depois do saque, a liquidez continuar cobrindo o principal da Rende.
pub fn baleia_can_withdraw(available: u64, amount: u64, rende_principal: u64) -> bool {
    available.checked_sub(amount).map_or(false, |left| left >= rende_principal)
}

/// Taxas pendentes de uma posição, nas duas moedas.
pub fn pending_fees(shares: u128, acc: [u128; 2], debt: [u128; 2]) -> Result<[u64; 2]> {
    let mut out = [0u64; 2];
    for s in 0..2 {
        let accrued = shares.checked_mul(acc[s]).ok_or(error!(CambiError::MathOverflow))? / ACC_SCALE;
        out[s] = u64::try_from(accrued.saturating_sub(debt[s])).map_err(|_| error!(CambiError::MathOverflow))?;
    }
    Ok(out)
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
pub fn quote(pool: &Pool, s_in: usize, amount_in: u64, kind: UserKind, brl_avail: u64, usd_avail: u64) -> Result<Quote> {
    let f = &pool.fees;
    let (base_bps, pix_bps) = match kind {
        UserKind::Depositor => (f.depositor_bps, f.depositor_pix_bps),
        UserKind::Retail => (f.retail_bps, f.retail_pix_bps),
        UserKind::B2b => (f.b2b_bps, f.b2b_pix_bps),
    };
    let (base_bps, pix_bps) = (base_bps as u128, pix_bps as u128);

    // Desequilíbrio em bps (-10000..10000): positivo = sobra real.
    let price = pool.price as u128;
    let brl = brl_avail as u128;
    let usd_in_brl = (usd_avail as u128) * price / PRICE_SCALE;
    let total = brl + usd_in_brl;
    let imb: i128 = if total == 0 { 0 } else { ((brl as i128) - (usd_in_brl as i128)) * (BPS as i128) / (total as i128) };
    let worsens = if s_in == BRL { imb } else { -imb };
    let mult = (BPS as i128 + worsens).clamp(f.dynamic_min_bps as i128, f.dynamic_max_bps as i128) as u128;
    let fee_bps = base_bps * mult / BPS;

    let amount = amount_in as u128;
    let fee = amount * fee_bps / BPS;
    let net = amount - fee;
    let amount_out = if s_in == BRL { net * PRICE_SCALE / price } else { net * price / PRICE_SCALE };

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

/// Saldo do cofre que pode ser usado em trocas e saques de principal (exclui taxas reservadas).
pub fn available(pool: &Pool, vault_amount: u64, s: usize) -> u64 {
    let reserved = pool.platform_fees[s] + pool.partner_fees[s] + pool.lp_fees_unclaimed[s];
    vault_amount.saturating_sub(reserved)
}

fn harvest(pool: &mut Pool, pos: &Position) -> Result<[u64; 2]> {
    let t = pos.tranche as usize;
    let acc = [pool.acc_fee_per_share[idx(t, BRL)], pool.acc_fee_per_share[idx(t, USD)]];
    let pending = pending_fees(pos.shares, acc, pos.reward_debt)?;
    for s in 0..2 {
        pool.lp_fees_unclaimed[s] = pool.lp_fees_unclaimed[s].saturating_sub(pending[s]);
    }
    Ok(pending)
}

fn sync_debt(pool: &Pool, pos: &mut Position) {
    let t = pos.tranche as usize;
    for s in 0..2 {
        pos.reward_debt[s] = pos.shares * pool.acc_fee_per_share[idx(t, s)] / ACC_SCALE;
    }
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

fn pay_pending<'info>(
    pool: &Account<'info, Pool>,
    vaults: [&Account<'info, TokenAccount>; 2],
    dests: [&Account<'info, TokenAccount>; 2],
    token_program: &Program<'info, Token>,
    pending: [u64; 2],
) -> Result<()> {
    for s in 0..2 {
        if pending[s] > 0 {
            pay_from_vault(pool, vaults[s], dests[s], token_program, pending[s])?;
        }
    }
    Ok(())
}

// ---------- contas ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug, PartialEq, Eq)]
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
    pub max_trade_bps: u16,
}

impl Default for FeeConfig {
    fn default() -> Self {
        Self {
            depositor_bps: 50,         // 0,5%
            retail_bps: 100,           // 1,0%
            b2b_bps: 40,               // 0,4%
            depositor_pix_bps: 5_000,  // 50% do volume passa pelo Pix
            retail_pix_bps: 10_000,
            b2b_pix_bps: 2_000,
            partner_cost_bps: 20,      // 0,2% do volume via Pix
            platform_share_bps: 2_500, // 25% da taxa líquida
            baleia_share_bps: 7_000,   // 70% do que vai para provedores de liquidez
            dynamic_min_bps: 7_000,    // taxa pode cair até 0,7x
            dynamic_max_bps: 15_000,   // ou subir até 1,5x
            max_trade_bps: 2_000,      // uma troca leva no máximo 20% da liquidez de saída
        }
    }
}

impl FeeConfig {
    pub fn validate(&self) -> Result<()> {
        let pct_ok = |v: u16| v as u128 <= BPS;
        require!(
            self.depositor_bps <= 500 && self.retail_bps <= 500 && self.b2b_bps <= 500,
            CambiError::InvalidConfig
        ); // nenhuma taxa base acima de 5%
        require!(
            [self.depositor_pix_bps, self.retail_pix_bps, self.b2b_pix_bps, self.platform_share_bps, self.baleia_share_bps]
                .into_iter()
                .all(pct_ok),
            CambiError::InvalidConfig
        );
        require!(self.partner_cost_bps <= 100, CambiError::InvalidConfig);
        require!(
            self.dynamic_min_bps <= BPS as u16 && self.dynamic_max_bps >= BPS as u16 && self.dynamic_max_bps <= 30_000,
            CambiError::InvalidConfig
        );
        require!(self.max_trade_bps > 0 && pct_ok(self.max_trade_bps), CambiError::InvalidConfig);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub brl_mint: Pubkey,
    pub usd_mint: Pubkey,
    pub brl_vault: Pubkey,
    pub usd_vault: Pubkey,
    pub price: u64,
    pub price_updated_at: i64,
    pub max_price_age: i64,
    pub fees: FeeConfig,
    pub paused: bool,
    /// Principal por camada e moeda: [rende_brl, rende_usd, baleia_brl, baleia_usd]
    pub principal: [u64; 4],
    /// Shares (valor em reais no depósito) por camada: [rende, baleia]
    pub shares: [u128; 2],
    /// Taxas acumuladas por share, por camada e moeda da taxa: [rende_brl, rende_usd, baleia_brl, baleia_usd]
    pub acc_fee_per_share: [u128; 4],
    /// Por moeda: [brl, usd]
    pub lp_fees_unclaimed: [u64; 2],
    pub platform_fees: [u64; 2],
    pub partner_fees: [u64; 2],
    pub swap_count: u64,
    pub volume_brl: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub tranche: u8,
    pub side: u8,
    /// Principal na moeda depositada
    pub amount: u64,
    /// Participação nas taxas da camada (valor em reais no momento do depósito)
    pub shares: u128,
    /// Taxas já contabilizadas, por moeda da taxa
    pub reward_debt: [u128; 2],
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

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub tranche: u8,
    pub side: u8,
    pub amount: u64,
}

#[event]
pub struct WithdrawEvent {
    pub user: Pubkey,
    pub tranche: u8,
    pub side: u8,
    pub amount: u64,
    pub fees: [u64; 2],
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
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
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
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref(), &[tranche], &[side]], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub brl_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub usd_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut, has_one = pool,
        constraint = position.owner == user.key() @ CambiError::InvalidPosition,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref(), &[position.tranche], &[position.side]],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub brl_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub usd_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.brl_mint)]
    pub user_brl: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.usd_mint)]
    pub user_usd: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub brl_vault: Account<'info, TokenAccount>,
    #[account(mut)]
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
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum CambiError {
    #[msg("Preço inválido")]
    InvalidPrice,
    #[msg("Configuração inválida")]
    InvalidConfig,
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
    #[msg("A Baleia só saca se o cofre continuar cobrindo o principal da Rende")]
    BaleiaJuniorLiquidity,
    #[msg("Troca maior que o limite por operação")]
    TradeTooLarge,
    #[msg("Pool pausado: trocas e depósitos suspensos")]
    Paused,
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
            brl_vault: Pubkey::default(),
            usd_vault: Pubkey::default(),
            price,
            price_updated_at: 0,
            max_price_age: 60,
            fees: FeeConfig::default(),
            paused: false,
            principal: [0; 4],
            shares: [0; 2],
            acc_fee_per_share: [0; 4],
            lp_fees_unclaimed: [0; 2],
            platform_fees: [0; 2],
            partner_fees: [0; 2],
            swap_count: 0,
            volume_brl: 0,
            bump: 0,
        }
    }

    const R: u64 = 1_000_000; // 1 unidade com 6 casas

    #[test]
    fn taxa_base_com_pool_equilibrado() {
        let p = pool(5_400_000); // R$ 5,40
        let q = quote(&p, BRL, 5_400 * R, UserKind::Retail, 540_000 * R, 100_000 * R).unwrap();
        assert_eq!(q.fee, 54 * R); // 1%
        assert_eq!(q.amount_out, (5_400 - 54) * R * 1_000_000 / 5_400_000);
    }

    #[test]
    fn divisao_da_taxa_soma_o_total() {
        let p = pool(5_400_000);
        let q = quote(&p, BRL, 10_000 * R, UserKind::Retail, 540_000 * R, 100_000 * R).unwrap();
        assert_eq!(q.to_partner + q.to_platform + q.to_baleia + q.to_rende, q.fee);
        assert!(q.to_baleia > q.to_rende);
    }

    #[test]
    fn depositante_paga_metade() {
        let p = pool(5_400_000);
        let r = quote(&p, BRL, 1_000 * R, UserKind::Retail, 540_000 * R, 100_000 * R).unwrap();
        let d = quote(&p, BRL, 1_000 * R, UserKind::Depositor, 540_000 * R, 100_000 * R).unwrap();
        assert_eq!(d.fee * 2, r.fee);
    }

    #[test]
    fn taxa_dinamica_encarece_quem_desequilibra() {
        let p = pool(5_400_000);
        // Sobra real: 900 mil reais contra 50 mil dólares (270 mil reais).
        let piora = quote(&p, BRL, 1_000 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap();
        let melhora = quote(&p, USD, 185 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap();
        assert!(piora.fee > 10 * R); // acima de 1%
        assert!(melhora.fee * 100 < 185 * R); // abaixo de 1%
    }

    #[test]
    fn available_desconta_taxas_reservadas() {
        let mut p = pool(5_400_000);
        p.platform_fees[BRL] = 10;
        p.partner_fees[BRL] = 5;
        p.lp_fees_unclaimed[BRL] = 20;
        assert_eq!(available(&p, 100, BRL), 65);
    }

    #[test]
    fn shares_usam_valor_em_reais() {
        assert_eq!(value_in_brl(5_400_000, BRL, 1_000 * R).unwrap(), (1_000 * R) as u128);
        assert_eq!(value_in_brl(5_400_000, USD, 100 * R).unwrap(), (540 * R) as u128);
    }

    #[test]
    fn taxas_pendentes_nas_duas_moedas() {
        // 1.000 shares; acumulou 0,5 BRL e 0,1 USD por share; já tinha recebido 100 BRL.
        let shares = 1_000u128;
        let acc = [ACC_SCALE / 2, ACC_SCALE / 10];
        let p = pending_fees(shares, acc, [100, 0]).unwrap();
        assert_eq!(p, [400, 100]);
    }

    #[test]
    fn rende_e_senior_sobre_a_baleia() {
        // Cofre com 1.000 livres; Rende tem 900 de principal.
        assert!(baleia_can_withdraw(1_000, 100, 900));
        assert!(!baleia_can_withdraw(1_000, 101, 900));
        assert!(!baleia_can_withdraw(50, 100, 0));
    }

    #[test]
    fn configuracao_padrao_e_valida_e_limites_sao_aplicados() {
        assert!(FeeConfig::default().validate().is_ok());
        let caro = FeeConfig { retail_bps: 600, ..FeeConfig::default() };
        assert!(caro.validate().is_err());
        let sem_limite = FeeConfig { max_trade_bps: 0, ..FeeConfig::default() };
        assert!(sem_limite.validate().is_err());
    }
}
