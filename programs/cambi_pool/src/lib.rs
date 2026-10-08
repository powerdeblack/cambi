//! cambI pool: casa de câmbio on-chain (real digital <-> dólar digital) em que
//! quem deposita recebe parte das taxas de cada troca.
//!
//! Regras principais (detalhes em docs/ARQUITETURA.md):
//! - troca ao preço do oráculo, recusada se a cotação estiver velha;
//! - taxa dinâmica: mais cara no sentido que desequilibra o pool;
//! - taxas divididas entre parceiro regulado, operação, Baleia e Rende;
//! - cada camada recebe taxas nas DUAS moedas, proporcional ao VALOR depositado (shares);
//! - a Rende é sênior: a Baleia só saca se o cofre continuar cobrindo todo o principal da Rende;
//! - limite por troca e por minuto, e pausa de emergência (saques continuam liberados durante a pausa);
//! - depósitos ficam travados por um período mínimo antes do resgate do principal (contra liquidez relâmpago);
//! - o oráculo só move o preço dentro de um limite por atualização.
//!
//! Auditoria e correções: docs/AUDITORIA.md.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "cambI pool",
    project_url: "https://github.com/powerdeblack/cambi",
    contacts: "link:https://github.com/powerdeblack/cambi/security/advisories/new",
    policy: "https://github.com/powerdeblack/cambi/blob/main/SECURITY.md",
    source_code: "https://github.com/powerdeblack/cambi",
    auditors: "Revisão interna: docs/AUDITORIA.md (sem auditoria externa ainda)"
}

declare_id!("AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ");

pub const PRICE_SCALE: u128 = 1_000_000; // preço = reais por dólar * 1e6
pub const ACC_SCALE: u128 = 1_000_000_000_000; // escala do acumulador de taxas por share
pub const BPS: u128 = 10_000;

pub const BRL: usize = 0;
pub const USD: usize = 1;
pub const RENDE: usize = 0;
pub const BALEIA: usize = 1;

/// Depósito mínimo e posição mínima para o desconto de depositante: R$ 10 (6 casas).
pub const MIN_DEPOSIT_BRL: u128 = 10_000_000;
/// Janela do limite de saída acumulada por moeda.
pub const WINDOW_SECS: i64 = 60;
pub const DEFAULT_LOCKUP_SECS: i64 = 600;
pub const DEFAULT_MAX_PRICE_MOVE_BPS: u16 = 1_000;
pub const MAX_PRICE_AGE_LIMIT: i64 = 86_400;
pub const MAX_LOCKUP_SECS: i64 = 7 * 86_400;

#[program]
pub mod cambi_pool {
    use super::*;

    /// Cria o pool de um par de moedas. Só a autoridade de upgrade do programa pode chamar (evita que alguém
    /// "tome" o endereço do pool de um par antes do time).
    pub fn initialize(ctx: Context<Initialize>, price: u64, max_price_age: i64) -> Result<()> {
        require!(price > 0, CambiError::InvalidPrice);
        require!(max_price_age > 0 && max_price_age <= MAX_PRICE_AGE_LIMIT, CambiError::InvalidConfig);
        require!(ctx.accounts.brl_mint.decimals == ctx.accounts.usd_mint.decimals, CambiError::MintDecimalsMismatch);
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
        pool.lockup_secs = DEFAULT_LOCKUP_SECS;
        pool.max_price_move_bps = DEFAULT_MAX_PRICE_MOVE_BPS;
        Ok(())
    }

    /// Atualiza a cotação (reais por dólar, escala 1e6). Só a autoridade de oráculo.
    /// A variação por atualização é limitada (`max_price_move_bps`): uma chave de oráculo comprometida não
    /// consegue saltar o preço para drenar os cofres numa tacada.
    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        require!(price > 0, CambiError::InvalidPrice);
        let pool = &mut ctx.accounts.pool;
        require!(price_move_ok(pool.price, price, pool.max_price_move_bps), CambiError::PriceMoveTooLarge);
        pool.price = price;
        pool.price_updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Validade máxima da cotação, variação máxima por atualização do oráculo e trava mínima dos depósitos.
    pub fn set_limits(ctx: Context<AdminOnly>, max_price_age: i64, max_price_move_bps: u16, lockup_secs: i64) -> Result<()> {
        require!(max_price_age > 0 && max_price_age <= MAX_PRICE_AGE_LIMIT, CambiError::InvalidConfig);
        require!((10..=5_000).contains(&max_price_move_bps), CambiError::InvalidConfig);
        require!((0..=MAX_LOCKUP_SECS).contains(&lockup_secs), CambiError::InvalidConfig);
        let pool = &mut ctx.accounts.pool;
        pool.max_price_age = max_price_age;
        pool.max_price_move_bps = max_price_move_bps;
        pool.lockup_secs = lockup_secs;
        Ok(())
    }

    /// Troca de admin em dois passos: o atual propõe, o novo aceita (evita entregar o pool para uma chave errada).
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.pool.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require_keys_eq!(pool.pending_admin, ctx.accounts.new_admin.key(), CambiError::NotPendingAdmin);
        require_keys_neq!(pool.pending_admin, Pubkey::default(), CambiError::NotPendingAdmin);
        pool.admin = pool.pending_admin;
        pool.pending_admin = Pubkey::default();
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
        let now = Clock::get()?.unix_timestamp;
        // Shares são calculadas pelo preço: não aceita depósito com cotação velha.
        require!(price_fresh(&ctx.accounts.pool, now), CambiError::StalePrice);
        require!(value_in_brl(ctx.accounts.pool.price, s, amount)? >= MIN_DEPOSIT_BRL, CambiError::DepositTooSmall);

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
            pos.last_deposit_at = now;
            sync_debt(pool, pos)?;
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
    /// `amount = 0` só colhe as taxas (permitido a qualquer momento, inclusive com o pool pausado).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let t = tranche_idx(ctx.accounts.position.tranche)?;
        let s = side_idx(ctx.accounts.position.side)?;
        require!(amount <= ctx.accounts.position.amount, CambiError::InsufficientPosition);
        if amount > 0 {
            let now = Clock::get()?.unix_timestamp;
            let unlock = ctx.accounts.position.last_deposit_at.saturating_add(ctx.accounts.pool.lockup_secs);
            require!(now >= unlock, CambiError::PositionLocked);
        }

        let vaults = [ctx.accounts.brl_vault.amount, ctx.accounts.usd_vault.amount];
        let avail = available(&ctx.accounts.pool, vaults[s], s);
        require!(amount <= avail, CambiError::InsufficientLiquidity);
        if t == BALEIA && amount > 0 {
            // A Rende é sênior nas DUAS moedas: depois do saque da Baleia, cada cofre precisa continuar cobrindo
            // o principal da Rende naquela moeda (trocas movem valor de um cofre para o outro).
            let o = 1 - s;
            let avail_o = available(&ctx.accounts.pool, vaults[o], o);
            let p = ctx.accounts.pool.principal;
            require!(
                baleia_can_withdraw(avail, amount, p[idx(RENDE, s)]) && avail_o >= p[idx(RENDE, o)],
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
                pos.shares
                    .checked_mul(amount as u128)
                    .ok_or(CambiError::MathOverflow)?
                    / (pos.amount as u128)
            };
            pos.amount = pos.amount.checked_sub(amount).ok_or(CambiError::MathOverflow)?;
            pos.shares = pos.shares.checked_sub(removed).ok_or(CambiError::MathOverflow)?;
            pool.shares[t] = pool.shares[t].checked_sub(removed).ok_or(CambiError::MathOverflow)?;
            let i = idx(t, s);
            pool.principal[i] = pool.principal[i].checked_sub(amount).ok_or(CambiError::MathOverflow)?;
            sync_debt(pool, pos)?;
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
            require!(price_fresh(pool, now), CambiError::StalePrice);

            let kind = if let Some(p) = &ctx.accounts.partner {
                require!(p.authority == user_key && p.pool == pool_key, CambiError::InvalidPartner);
                UserKind::B2b
            } else if let Some(pos) = &ctx.accounts.depositor_position {
                require!(pos.owner == user_key && pos.pool == pool_key && pos.amount > 0, CambiError::InvalidPosition);
                // Desconto só para quem deixou pelo menos R$ 10 (não vale "depositar 1 centavo" para pagar metade).
                require!(
                    value_in_brl(pool.price, side_idx(pos.side)?, pos.amount)? >= MIN_DEPOSIT_BRL,
                    CambiError::InvalidPosition
                );
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
            (q, avail, now)
        };
        let (q, avail, now) = q;

        // Limite de saída acumulado por minuto (várias trocas na mesma transação ou em sequência não drenam o cofre).
        {
            let pool = &mut ctx.accounts.pool;
            if now.saturating_sub(pool.window_start) >= WINDOW_SECS {
                pool.window_start = now;
                pool.window_base = avail;
                pool.window_out = [0, 0];
            }
            let out_total = pool.window_out[s_out].checked_add(q.amount_out).ok_or(CambiError::MathOverflow)?;
            let cap = (pool.window_base[s_out] as u128) * (pool.fees.max_trade_bps as u128) / BPS;
            require!((out_total as u128) <= cap, CambiError::OutflowLimit);
            pool.window_out[s_out] = out_total;
        }

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
        pool.partner_fees[s_in] = pool.partner_fees[s_in].checked_add(q.to_partner).ok_or(CambiError::MathOverflow)?;
        pool.platform_fees[s_in] = pool.platform_fees[s_in].checked_add(q.to_platform).ok_or(CambiError::MathOverflow)?;
        for (t, share) in [(RENDE, q.to_rende), (BALEIA, q.to_baleia)] {
            if pool.shares[t] == 0 {
                // camada vazia: vai para a operação
                pool.platform_fees[s_in] = pool.platform_fees[s_in].checked_add(share).ok_or(CambiError::MathOverflow)?;
            } else {
                pool.lp_fees_unclaimed[s_in] = pool.lp_fees_unclaimed[s_in].checked_add(share).ok_or(CambiError::MathOverflow)?;
                let inc = (share as u128).checked_mul(ACC_SCALE).ok_or(CambiError::MathOverflow)? / pool.shares[t];
                let i = idx(t, s_in);
                pool.acc_fee_per_share[i] = pool.acc_fee_per_share[i].checked_add(inc).ok_or(CambiError::MathOverflow)?;
            }
        }
        pool.swap_count = pool.swap_count.saturating_add(1);
        let vol = u64::try_from(value_in_brl(pool.price, s_in, amount_in)?).unwrap_or(u64::MAX);
        pool.volume_brl = pool.volume_brl.saturating_add(vol);

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
        let amount = ctx.accounts.pool.platform_fees[s]
            .checked_add(ctx.accounts.pool.partner_fees[s])
            .ok_or(CambiError::MathOverflow)?;
        require!(amount > 0, CambiError::ZeroAmount);
        pay_from_vault(&ctx.accounts.pool, &ctx.accounts.vault, &ctx.accounts.destination, &ctx.accounts.token_program, amount)?;
        let pool = &mut ctx.accounts.pool;
        pool.platform_fees[s] = 0;
        pool.partner_fees[s] = 0;
        Ok(())
    }

    /// SÓ DEVNET (feature `devnet`): dá moedas de teste (cBRL) para quem pede, com regras on-chain:
    /// uma vez por hora por carteira, só para quem tem pouco saldo, e um teto global por hora.
    /// Substitui a carteira patrocinadora: nenhuma chave com poder de emissão fica no app.
    #[cfg(feature = "devnet")]
    pub fn faucet_claim(ctx: Context<FaucetClaim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let claim = &mut ctx.accounts.claim;
        if claim.last_claim_at != 0 {
            require!(now.saturating_sub(claim.last_claim_at) >= FAUCET_COOLDOWN_SECS, CambiError::FaucetCooldown);
        }
        require!(ctx.accounts.user_brl.amount < FAUCET_MAX_BALANCE, CambiError::FaucetBalanceTooHigh);
        let pool = &mut ctx.accounts.pool;
        if now.saturating_sub(pool.faucet_window_start) >= 3_600 {
            pool.faucet_window_start = now;
            pool.faucet_window_minted = 0;
        }
        let minted = pool.faucet_window_minted.checked_add(FAUCET_AMOUNT).ok_or(CambiError::MathOverflow)?;
        require!(minted <= FAUCET_HOURLY_CAP, CambiError::FaucetHourlyCap);
        pool.faucet_window_minted = minted;
        claim.last_claim_at = now;
        claim.bump = ctx.bumps.claim;

        let pool_key = ctx.accounts.pool.key();
        let seeds: &[&[u8]] = &[b"mint-authority", pool_key.as_ref(), &[ctx.bumps.mint_authority]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.brl_mint.to_account_info(),
                    to: ctx.accounts.user_brl.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            FAUCET_AMOUNT,
        )
    }

    /// SÓ DEVNET (feature `devnet`): o admin emite moedas de teste para repor liquidez da demonstração.
    #[cfg(feature = "devnet")]
    pub fn admin_mint(ctx: Context<AdminMint>, side: u8, amount: u64) -> Result<()> {
        let s = side_idx(side)?;
        let expected = if s == BRL { ctx.accounts.pool.brl_mint } else { ctx.accounts.pool.usd_mint };
        require_keys_eq!(ctx.accounts.mint.key(), expected, CambiError::InvalidSide);
        require!(amount > 0, CambiError::ZeroAmount);
        let pool_key = ctx.accounts.pool.key();
        let seeds: &[&[u8]] = &[b"mint-authority", pool_key.as_ref(), &[ctx.bumps.mint_authority]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }
}

#[cfg(feature = "devnet")]
pub const FAUCET_AMOUNT: u64 = 1_000_000_000; // R$ 1.000 de teste
#[cfg(feature = "devnet")]
pub const FAUCET_COOLDOWN_SECS: i64 = 3_600;
#[cfg(feature = "devnet")]
pub const FAUCET_MAX_BALANCE: u64 = 100_000_000; // só quem tem menos de R$ 100
#[cfg(feature = "devnet")]
pub const FAUCET_HOURLY_CAP: u64 = 50_000_000_000; // R$ 50 mil por hora no total

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

/// Cotação dentro da validade.
pub fn price_fresh(pool: &Pool, now: i64) -> bool {
    now.saturating_sub(pool.price_updated_at) <= pool.max_price_age
}

/// Nova cotação dentro do limite de variação em relação à atual.
pub fn price_move_ok(old: u64, new: u64, max_move_bps: u16) -> bool {
    (old.abs_diff(new) as u128) * BPS <= (old as u128) * (max_move_bps as u128)
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
    let mut pending = pending_fees(pos.shares, acc, pos.reward_debt)?;
    for s in 0..2 {
        // Arredondamentos nunca pagam taxa com dinheiro do principal: no máximo o que está reservado.
        pending[s] = pending[s].min(pool.lp_fees_unclaimed[s]);
        pool.lp_fees_unclaimed[s] -= pending[s];
    }
    Ok(pending)
}

fn sync_debt(pool: &Pool, pos: &mut Position) -> Result<()> {
    let t = pos.tranche as usize;
    for s in 0..2 {
        pos.reward_debt[s] = pos
            .shares
            .checked_mul(pool.acc_fee_per_share[idx(t, s)])
            .ok_or(CambiError::MathOverflow)?
            / ACC_SCALE;
    }
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
    /// Admin proposto (troca em dois passos); `default` quando não há proposta.
    pub pending_admin: Pubkey,
    /// Tempo mínimo entre o último depósito e o resgate do principal.
    pub lockup_secs: i64,
    /// Variação máxima da cotação por atualização do oráculo.
    pub max_price_move_bps: u16,
    /// Limite de saída acumulado: início da janela, liquidez livre no início e quanto já saiu, por moeda.
    pub window_start: i64,
    pub window_base: [u64; 2],
    pub window_out: [u64; 2],
    /// Faucet de devnet: teto global por hora.
    pub faucet_window_start: i64,
    pub faucet_window_minted: u64,
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
    /// Momento do último depósito (para a trava de resgate).
    pub last_deposit_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct FaucetClaimState {
    pub last_claim_at: i64,
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
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ CambiError::Unauthorized)]
    pub program: Program<'info, crate::program::CambiPool>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ CambiError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
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
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut)]
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
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
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

#[cfg(feature = "devnet")]
#[derive(Accounts)]
pub struct FaucetClaim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_mint)]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed, payer = user, space = 8 + FaucetClaimState::INIT_SPACE,
        seeds = [b"claim", pool.key().as_ref(), user.key().as_ref()], bump
    )]
    pub claim: Account<'info, FaucetClaimState>,
    #[account(mut)]
    pub brl_mint: Account<'info, Mint>,
    #[account(mut, token::mint = brl_mint, token::authority = user)]
    pub user_brl: Account<'info, TokenAccount>,
    /// CHECK: PDA que é a autoridade de emissão das moedas de teste; só assina via seeds.
    #[account(seeds = [b"mint-authority", pool.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "devnet")]
#[derive(Accounts)]
pub struct AdminMint<'info> {
    pub admin: Signer<'info>,
    #[account(has_one = admin)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub destination: Account<'info, TokenAccount>,
    /// CHECK: PDA autoridade de emissão; só assina via seeds.
    #[account(seeds = [b"mint-authority", pool.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
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
    #[msg("Variação da cotação acima do limite por atualização")]
    PriceMoveTooLarge,
    #[msg("Depósito ainda no período mínimo antes do resgate")]
    PositionLocked,
    #[msg("Limite de saída do pool neste minuto atingido; tente em instantes")]
    OutflowLimit,
    #[msg("Depósito mínimo de R$ 10")]
    DepositTooSmall,
    #[msg("Esta carteira não é o admin proposto")]
    NotPendingAdmin,
    #[msg("As duas moedas precisam ter as mesmas casas decimais")]
    MintDecimalsMismatch,
    #[msg("Só a autoridade de upgrade do programa pode fazer isso")]
    Unauthorized,
    #[msg("Moedas de teste: aguarde 1 hora entre pedidos")]
    FaucetCooldown,
    #[msg("Moedas de teste só para quem tem menos de R$ 100")]
    FaucetBalanceTooHigh,
    #[msg("Limite de moedas de teste desta hora atingido; tente mais tarde")]
    FaucetHourlyCap,
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
            pending_admin: Pubkey::default(),
            lockup_secs: DEFAULT_LOCKUP_SECS,
            max_price_move_bps: DEFAULT_MAX_PRICE_MOVE_BPS,
            window_start: 0,
            window_base: [0; 2],
            window_out: [0; 2],
            faucet_window_start: 0,
            faucet_window_minted: 0,
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
    fn oraculo_nao_salta_o_preco() {
        assert!(price_move_ok(5_000_000, 5_500_000, 1_000)); // +10%
        assert!(!price_move_ok(5_000_000, 5_500_001, 1_000));
        assert!(price_move_ok(5_000_000, 4_500_000, 1_000)); // -10%
        assert!(!price_move_ok(5_000_000, 1, 1_000));
    }

    #[test]
    fn cotacao_fresca_e_velha() {
        let mut p = pool(5_000_000);
        p.price_updated_at = 1_000;
        p.max_price_age = 60;
        assert!(price_fresh(&p, 1_060));
        assert!(!price_fresh(&p, 1_061));
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
