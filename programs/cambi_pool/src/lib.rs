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
//! Versão 2 (gargalos de segurança):
//! - só carteiras com credencial KYC válida (emitida pelo parceiro regulado) trocam e depositam;
//!   cada nível de credencial tem um teto por operação. Sacar continua livre: ninguém fica preso;
//! - disjuntor: a saída somada (trocas + saques imediatos) por janela tem teto por moeda;
//! - saques grandes entram numa fila com aviso prévio, e o valor fica reservado até o resgate;
//! - guardião: chave de emergência que SÓ pausa; despausar é do admin (multisig);
//! - a autoridade de upgrade do programa fica numa multisig com prazo de espera (fora do código);
//! - prova de reserva: o custodiante de cada moeda tokenizada atesta a reserva on-chain; se o total emitido
//!   passar da reserva atestada, ou o atestado ficar velho, trocas e depósitos param (saques seguem livres).
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
/// Desconto de depositante só para quem deixou pelo menos R$ 1.000 (painel de economia: R$ 10 vazava o desconto).
pub const DISCOUNT_MIN_BRL: u128 = 1_000_000_000;
/// Janela do limite de saída acumulada por moeda.
pub const WINDOW_SECS: i64 = 60;
pub const DEFAULT_LOCKUP_SECS: i64 = 600;
pub const DEFAULT_MAX_PRICE_MOVE_BPS: u16 = 1_000;
pub const MAX_PRICE_AGE_LIMIT: i64 = 86_400;
pub const MAX_LOCKUP_SECS: i64 = 7 * 86_400;
pub const DEFAULT_BREAKER_WINDOW_SECS: i64 = 3_600;
pub const DEFAULT_BREAKER_BPS: u16 = 3_000; // 30% da liquidez livre de cada moeda por hora
pub const DEFAULT_INSTANT_WITHDRAW_BPS: u16 = 1_000; // saque imediato até 10% da liquidez livre
pub const DEFAULT_WITHDRAW_NOTICE_SECS: i64 = 86_400; // acima disso, fila com 24 h de aviso
pub const MAX_WITHDRAW_NOTICE_SECS: i64 = 30 * 86_400;
/// Teto por operação (valor em reais, 6 casas) por nível de credencial: básico, completo, institucional (0 = sem teto).
pub const DEFAULT_LEVEL_LIMITS: [u64; 3] = [10_000_000_000, 100_000_000_000, 0];
/// Teto ACUMULADO em 24 h por nível (auditoria: o teto por operação sozinho não limita nada para PLD).
pub const DEFAULT_DAILY_LIMITS: [u64; 3] = [30_000_000_000, 300_000_000_000, 0];
/// Desconto de preço para quem reequilibra, por 100% de desequilíbrio restante (2%).
pub const DEFAULT_REBALANCE_K_BPS: u16 = 200;
/// Prêmio de escassez no depósito: cotas a mais para quem deposita a moeda que falta, k × 5 por 100% de
/// desequilíbrio restante (com k = 2%: 10% de cotas a mais num pool 100% desequilibrado), no máximo 10%.
pub const DEPOSIT_PREMIUM_MULT: u128 = 5;
pub const MAX_DEPOSIT_PREMIUM_BPS: u128 = 1_000;
/// Validade máxima de uma credencial emitida (renovação anual do cadastro).
pub const MAX_CREDENTIAL_SECS: i64 = 400 * 86_400;
/// Aviso prévio mínimo da fila de saque (com zero, a fila viraria saque imediato fora do disjuntor).
pub const MIN_WITHDRAW_NOTICE_SECS: i64 = 60;
/// Travas do programa guardião (v2.6): "respirar" bloqueia só o sentido que drena uma moeda; "descansar" pausa
/// trocas e depósitos. As duas soltam sozinhas pelo tempo e têm teto, para o guardião nunca virar uma arma.
pub const MAX_BREATHE_SECS: i64 = 30 * 60;
pub const MAX_REST_SECS: i64 = 2 * 3_600;
/// Teto de descanso somado por dia: o guardião não consegue deixar o pool parado o dia todo.
pub const MAX_REST_PER_DAY_SECS: i64 = 6 * 3_600;
/// Reserva da Rende: parte do principal que fica guardada na própria moeda (a definir; 30% por enquanto).
pub const DEFAULT_RENDE_RESERVE_BPS: u16 = 3_000;
pub const MIN_RENDE_RESERVE_BPS: u16 = 2_000;
pub const LOCK_BREATHE: u8 = 1;
pub const LOCK_REST: u8 = 2;
pub const LOCK_STOP: u8 = 3;
#[cfg(feature = "devnet")]
pub const DEVNET_CREDENTIAL_SECS: i64 = 30 * 86_400;

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
        pool.guardian = ctx.accounts.admin.key();
        pool.kyc_issuer = ctx.accounts.admin.key();
        pool.require_kyc = true;
        pool.breaker_window_secs = DEFAULT_BREAKER_WINDOW_SECS;
        pool.breaker_bps = DEFAULT_BREAKER_BPS;
        pool.instant_withdraw_bps = DEFAULT_INSTANT_WITHDRAW_BPS;
        pool.withdraw_notice_secs = DEFAULT_WITHDRAW_NOTICE_SECS;
        pool.level_limit_brl = DEFAULT_LEVEL_LIMITS;
        pool.level_daily_brl = DEFAULT_DAILY_LIMITS;
        pool.rebalance_k_bps = DEFAULT_REBALANCE_K_BPS;
        pool.rende_reserve_bps = DEFAULT_RENDE_RESERVE_BPS;
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
        emit!(PauseEvent { by: ctx.accounts.admin.key(), paused });
        Ok(())
    }

    /// Guardião: chave de emergência (pode ficar num celular de plantão) que só consegue PAUSAR.
    /// Não mexe em preço, taxas, cofres nem despausa: se vazar, o pior que faz é pausar trocas.
    pub fn guardian_pause(ctx: Context<GuardianPause>) -> Result<()> {
        ctx.accounts.pool.paused = true;
        emit!(PauseEvent { by: ctx.accounts.guardian.key(), paused: true });
        Ok(())
    }

    /// Guardião (v2.6, em geral o PDA do programa guardião): trava com hora para acabar.
    /// Nível 1 "respirar": só trocas que tiram a moeda `side` param. Nível 2 "descansar": trocas e depósitos param.
    /// Nível 3 "parar": pausa total, que só o admin (conselho) solta. Saques nunca são bloqueados.
    pub fn guardian_lock(ctx: Context<GuardianPause>, level: u8, side: u8, secs: i64, reason: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        let until = apply_lock(pool, now, level, side, secs)?;
        emit!(GuardianLockEvent { by: ctx.accounts.guardian.key(), level, side, until, reason });
        Ok(())
    }

    /// O admin (conselho) solta as travas com tempo antes da hora, se concluir que foi alarme falso.
    pub fn clear_guardian_locks(ctx: Context<AdminOnly>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.rest_until = 0;
        pool.breathe_until = 0;
        emit!(GuardianLockEvent { by: ctx.accounts.admin.key(), level: 0, side: 0, until: 0, reason: 0 });
        Ok(())
    }

    pub fn set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
        ctx.accounts.pool.guardian = guardian;
        Ok(())
    }

    /// Quem emite as credenciais (o parceiro regulado que faz o KYC) e se elas são exigidas.
    pub fn set_kyc(ctx: Context<AdminOnly>, issuer: Pubkey, require_kyc: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.kyc_issuer = issuer;
        pool.require_kyc = require_kyc;
        Ok(())
    }

    /// Reserva da Rende em cada moeda (de 20% a 100% do principal dela).
    pub fn set_rende_reserve(ctx: Context<AdminOnly>, bps: u16) -> Result<()> {
        require!((MIN_RENDE_RESERVE_BPS as u128..=BPS).contains(&(bps as u128)), CambiError::InvalidConfig);
        ctx.accounts.pool.rende_reserve_bps = bps;
        Ok(())
    }

    /// Desconto para quem reequilibra (0 desliga; no máximo 5%).
    pub fn set_rebalance(ctx: Context<AdminOnly>, k_bps: u16) -> Result<()> {
        require!(k_bps <= 500, CambiError::InvalidConfig);
        ctx.accounts.pool.rebalance_k_bps = k_bps;
        Ok(())
    }

    /// Teto acumulado em 24 h por nível de credencial (0 = sem teto).
    pub fn set_daily_limits(ctx: Context<AdminOnly>, level_daily_brl: [u64; 3]) -> Result<()> {
        ctx.accounts.pool.level_daily_brl = level_daily_brl;
        Ok(())
    }

    /// Quem atesta as reservas das moedas tokenizadas (custodiante/auditor) e a validade máxima do atestado.
    /// `max_age = 0` desliga a exigência (ex.: moedas de teste sem custodiante).
    pub fn set_reserve_policy(ctx: Context<AdminOnly>, attester: Pubkey, max_age: i64) -> Result<()> {
        require!((0..=30 * 86_400).contains(&max_age), CambiError::InvalidConfig);
        let pool = &mut ctx.accounts.pool;
        pool.reserve_attester = attester;
        pool.reserve_max_age = max_age;
        Ok(())
    }

    /// O custodiante publica a reserva que lastreia uma das moedas do pool (em unidades do token).
    pub fn attest_reserves(ctx: Context<AttestReserves>, reserves: u64) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let pool = &ctx.accounts.pool;
        require!(mint == pool.brl_mint || mint == pool.usd_mint, CambiError::InvalidSide);
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.reserve;
        r.pool = pool.key();
        r.mint = mint;
        r.reserves = reserves;
        r.attested_at = now;
        r.attester = ctx.accounts.attester.key();
        r.bump = ctx.bumps.reserve;
        emit!(ReserveEvent { mint, reserves, supply: ctx.accounts.mint.supply, at: now });
        Ok(())
    }

    /// Disjuntor, fila de saque e tetos por nível de credencial, sempre dentro de limites fixos no código.
    pub fn set_safety(
        ctx: Context<AdminOnly>,
        breaker_window_secs: i64,
        breaker_bps: u16,
        instant_withdraw_bps: u16,
        withdraw_notice_secs: i64,
        level_limit_brl: [u64; 3],
    ) -> Result<()> {
        require!((60..=86_400).contains(&breaker_window_secs), CambiError::InvalidConfig);
        require!((100..=10_000).contains(&breaker_bps), CambiError::InvalidConfig);
        require!(instant_withdraw_bps <= 10_000, CambiError::InvalidConfig);
        require!((MIN_WITHDRAW_NOTICE_SECS..=MAX_WITHDRAW_NOTICE_SECS).contains(&withdraw_notice_secs), CambiError::InvalidConfig);
        let pool = &mut ctx.accounts.pool;
        pool.breaker_window_secs = breaker_window_secs;
        pool.breaker_bps = breaker_bps;
        pool.instant_withdraw_bps = instant_withdraw_bps;
        pool.withdraw_notice_secs = withdraw_notice_secs;
        pool.level_limit_brl = level_limit_brl;
        Ok(())
    }

    /// O emissor de KYC registra (ou renova) a credencial de uma carteira. Nada de dado pessoal on-chain:
    /// só o nível, a validade e quem emitiu.
    pub fn issue_credential(ctx: Context<IssueCredential>, level: u8, expires_at: i64) -> Result<()> {
        require!((1..=3).contains(&level), CambiError::InvalidConfig);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now && expires_at <= now.saturating_add(MAX_CREDENTIAL_SECS), CambiError::InvalidConfig);
        let c = &mut ctx.accounts.credential;
        // Auditoria v2 (achado 7): revogada só volta pelo admin (restore_credential), não por reemissão.
        require!(!c.revoked, CambiError::CredentialRevoked);
        c.pool = ctx.accounts.pool.key();
        c.user = ctx.accounts.user.key();
        c.issuer = ctx.accounts.issuer.key();
        c.level = level;
        c.expires_at = expires_at;
        c.revoked = false;
        c.bump = ctx.bumps.credential;
        emit!(CredentialEvent { user: c.user, level, expires_at, revoked: false });
        Ok(())
    }

    /// Revoga a credencial (sanção, fraude, pedido do regulador). A pessoa ainda consegue sacar o que é dela.
    pub fn revoke_credential(ctx: Context<RevokeCredential>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let who = ctx.accounts.authority.key();
        require!(who == pool.kyc_issuer || who == pool.admin, CambiError::Unauthorized);
        let c = &mut ctx.accounts.credential;
        c.revoked = true;
        emit!(CredentialEvent { user: c.user, level: c.level, expires_at: c.expires_at, revoked: true });
        Ok(())
    }

    /// Indisponibilidade de bens (Lei 13.810/2019: sanções do CSNU; ordem judicial). Emissor de KYC ou admin.
    /// Diferente da revogação: bloqueia também os saques, até a liberação.
    pub fn set_frozen(ctx: Context<RevokeCredential>, frozen: bool) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let who = ctx.accounts.authority.key();
        require!(who == pool.kyc_issuer || who == pool.admin, CambiError::Unauthorized);
        let c = &mut ctx.accounts.credential;
        c.frozen = frozen;
        emit!(FreezeEvent { user: c.user, frozen, by: who });
        Ok(())
    }

    /// Desfaz uma revogação (decisão do admin, ou seja, da multisig).
    pub fn restore_credential(ctx: Context<RestoreCredential>) -> Result<()> {
        let c = &mut ctx.accounts.credential;
        c.revoked = false;
        emit!(CredentialEvent { user: c.user, level: c.level, expires_at: c.expires_at, revoked: false });
        Ok(())
    }

    /// Descredencia um app parceiro (B2B): fecha a conta e devolve o aluguel ao admin.
    pub fn remove_partner(_ctx: Context<RemovePartner>) -> Result<()> {
        Ok(())
    }

    /// SÓ DEVNET: credencial básica de teste, para quem quiser experimentar o app sem o parceiro de KYC.
    /// Na mainnet esta instrução não existe: só o emissor regulado cria credenciais.
    #[cfg(feature = "devnet")]
    pub fn devnet_credential(ctx: Context<DevnetCredential>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.credential;
        // Não reabilita quem foi revogado nem rebaixa uma credencial de nível maior.
        require!(!c.revoked, CambiError::CredentialRevoked);
        if c.user == Pubkey::default() {
            c.pool = ctx.accounts.pool.key();
            c.user = ctx.accounts.user.key();
            c.issuer = ctx.accounts.user.key();
            c.level = 1;
            c.bump = ctx.bumps.credential;
        }
        c.expires_at = c.expires_at.max(now.saturating_add(DEVNET_CREDENTIAL_SECS));
        emit!(CredentialEvent { user: c.user, level: c.level, expires_at: c.expires_at, revoked: false });
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
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.pool.rest_until, CambiError::GuardianResting);
        let t = tranche_idx(tranche)?;
        let s = side_idx(side)?;
        let now = Clock::get()?.unix_timestamp;
        // Shares são calculadas pelo preço: não aceita depósito com cotação velha.
        require!(price_fresh(&ctx.accounts.pool, now), CambiError::StalePrice);
        require!(value_in_brl(ctx.accounts.pool.price, s, amount)? >= MIN_DEPOSIT_BRL, CambiError::DepositTooSmall);
        check_credential(
            &ctx.accounts.pool,
            ctx.accounts.pool.key(),
            ctx.accounts.user.key(),
            ctx.accounts.credential.as_deref().map(|c| &**c),
            value_in_brl(ctx.accounts.pool.price, s, amount)?,
            now,
        )?;
        if ctx.accounts.pool.require_kyc {
            let value = value_in_brl(ctx.accounts.pool.price, s, amount)?;
            if let Some(c) = ctx.accounts.credential.as_deref_mut() {
                // Baleia (júnior, provedor de liquidez): só instituição/investidor qualificado com credencial nível 3.
                require!(t != BALEIA || c.level == 3, CambiError::BaleiaNeedsLevel3);
                use_daily(c, &ctx.accounts.pool, now, value)?;
            }
        }
        check_backing(
            &ctx.accounts.pool,
            ctx.accounts.pool.key(),
            [&ctx.accounts.brl_mint, &ctx.accounts.usd_mint],
            [ctx.accounts.brl_reserve.as_deref().map(|r| &**r), ctx.accounts.usd_reserve.as_deref().map(|r| &**r)],
            now,
        )?;

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
            // Prêmio de escassez: quem traz a moeda que falta ganha mais cotas (mais participação nas taxas).
            let premium = deposit_premium_bps(
                pool,
                s,
                amount,
                swap_available(pool, ctx.accounts.brl_vault.amount, BRL),
                swap_available(pool, ctx.accounts.usd_vault.amount, USD),
            );
            let added = value_in_brl(pool.price, s, amount)? * (BPS + premium) / BPS;
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
        ensure_not_frozen(&ctx.accounts.credential)?;
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
        if amount > 0 {
            // Saque grande vai para a fila (request_withdraw).
            require!(
                instant_withdraw_ok(avail, amount, ctx.accounts.pool.instant_withdraw_bps),
                CambiError::UseWithdrawQueue
            );
            // O saque imediato também conta no disjuntor (base: a liquidez das trocas).
            let now = Clock::get()?.unix_timestamp;
            let free = [
                swap_available(&ctx.accounts.pool, vaults[BRL], BRL),
                swap_available(&ctx.accounts.pool, vaults[USD], USD),
            ];
            breaker_take(&mut ctx.accounts.pool, now, free, s, amount)?;
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
            lock_allows_swap(pool, now, s_out)?;
            require!(price_fresh(pool, now), CambiError::StalePrice);

            let kind = if let Some(p) = &ctx.accounts.partner {
                require!(p.authority == user_key && p.pool == pool_key, CambiError::InvalidPartner);
                UserKind::B2b
            } else if let Some(pos) = &ctx.accounts.depositor_position {
                require!(pos.owner == user_key && pos.pool == pool_key && pos.amount > 0, CambiError::InvalidPosition);
                // Desconto só para quem deixou pelo menos R$ 10 (não vale "depositar 1 centavo" para pagar metade).
                require!(
                    value_in_brl(pool.price, side_idx(pos.side)?, pos.amount)? >= DISCOUNT_MIN_BRL,
                    CambiError::InvalidPosition
                );
                UserKind::Depositor
            } else {
                UserKind::Retail
            };

            // Trocas não tocam a reserva da Rende: uma parte do principal dela fica guardada 1 para 1 em cada moeda.
            let avail = [
                swap_available(pool, ctx.accounts.brl_vault.amount, BRL),
                swap_available(pool, ctx.accounts.usd_vault.amount, USD),
            ];
            if kind == UserKind::B2b {
                // App parceiro (B2B): KYB no cadastro feito pelo admin; teto institucional por operação.
                let limit = pool.level_limit_brl[2];
                require!(limit == 0 || value_in_brl(pool.price, s_in, amount_in)? <= limit as u128, CambiError::AboveKycLimit);
            } else {
                check_credential(
                    pool,
                    pool_key,
                    user_key,
                    ctx.accounts.credential.as_deref().map(|c| &**c),
                    value_in_brl(pool.price, s_in, amount_in)?,
                    now,
                )?;
            }
            check_backing(
                pool,
                pool_key,
                [&ctx.accounts.brl_mint, &ctx.accounts.usd_mint],
                [ctx.accounts.brl_reserve.as_deref().map(|r| &**r), ctx.accounts.usd_reserve.as_deref().map(|r| &**r)],
                now,
            )?;
            let q = quote(pool, s_in, amount_in, kind, avail[BRL], avail[USD])?;
            require!(q.amount_out > 0, CambiError::ZeroAmount);
            require!(q.amount_out >= min_out, CambiError::SlippageExceeded);
            require!(q.amount_out <= avail[s_out], CambiError::InsufficientLiquidity);
            let max_out = (avail[s_out] as u128) * (pool.fees.max_trade_bps as u128) / BPS;
            require!((q.amount_out as u128) <= max_out, CambiError::TradeTooLarge);
            (q, avail, now, kind)
        };
        let (q, avail, now, kind) = q;
        if ctx.accounts.pool.require_kyc && kind != UserKind::B2b {
            let value = value_in_brl(ctx.accounts.pool.price, s_in, amount_in)?;
            if let Some(c) = ctx.accounts.credential.as_deref_mut() {
                use_daily(c, &ctx.accounts.pool, now, value)?;
            }
        }

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
            // Disjuntor da janela longa (padrão: 1 hora), somando trocas e saques imediatos.
            breaker_take(pool, now, avail, s_out, q.amount_out)?;
            breaker_inflow(pool, now, avail, s_in, amount_in);
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

    /// Pede um saque grande: o valor sai da posição agora (para de render), fica reservado no cofre
    /// (trocas não usam) e pode ser resgatado depois do aviso prévio. Funciona com o pool pausado.
    pub fn request_withdraw(ctx: Context<RequestWithdraw>, amount: u64) -> Result<()> {
        ensure_not_frozen(&ctx.accounts.credential)?;
        require!(amount > 0, CambiError::ZeroAmount);
        let t = tranche_idx(ctx.accounts.position.tranche)?;
        let s = side_idx(ctx.accounts.position.side)?;
        require!(amount <= ctx.accounts.position.amount, CambiError::InsufficientPosition);
        let now = Clock::get()?.unix_timestamp;
        let unlock = ctx.accounts.position.last_deposit_at.saturating_add(ctx.accounts.pool.lockup_secs);
        require!(now >= unlock, CambiError::PositionLocked);

        let vaults = [ctx.accounts.brl_vault.amount, ctx.accounts.usd_vault.amount];
        let avail = available(&ctx.accounts.pool, vaults[s], s);
        // A Rende entra na fila mesmo com a moeda em falta (v2.6): a fila passa a ter prioridade sobre essa moeda
        // (trocas que a tiram param até a fila ser coberta) e, no fim do aviso, a pessoa espera ou recebe o valor
        // na outra moeda pelo preço do oráculo. A Baleia, júnior, só pede o que existe.
        if t == BALEIA {
            require!(amount <= avail, CambiError::InsufficientLiquidity);
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
            let removed = pos.shares.checked_mul(amount as u128).ok_or(CambiError::MathOverflow)? / (pos.amount as u128);
            pos.amount = pos.amount.checked_sub(amount).ok_or(CambiError::MathOverflow)?;
            pos.shares = pos.shares.checked_sub(removed).ok_or(CambiError::MathOverflow)?;
            pool.shares[t] = pool.shares[t].checked_sub(removed).ok_or(CambiError::MathOverflow)?;
            let i = idx(t, s);
            pool.principal[i] = pool.principal[i].checked_sub(amount).ok_or(CambiError::MathOverflow)?;
            pool.queued[s] = pool.queued[s].checked_add(amount).ok_or(CambiError::MathOverflow)?;
            // O que entra na fila sai da base do disjuntor desta janela.
            pool.breaker_base[s] = pool.breaker_base[s].saturating_sub(amount);
            sync_debt(pool, pos)?;
            pending
        };

        let ready_at = now.saturating_add(ctx.accounts.pool.withdraw_notice_secs);
        let ticket = &mut ctx.accounts.ticket;
        ticket.owner = ctx.accounts.user.key();
        ticket.pool = ctx.accounts.pool.key();
        ticket.side = s as u8;
        ticket.amount = amount;
        ticket.requested_at = now;
        ticket.ready_at = ready_at;
        ticket.bump = ctx.bumps.ticket;

        pay_pending(
            &ctx.accounts.pool,
            [&ctx.accounts.brl_vault, &ctx.accounts.usd_vault],
            [&ctx.accounts.user_brl, &ctx.accounts.user_usd],
            &ctx.accounts.token_program,
            pending,
        )?;
        emit!(WithdrawRequestedEvent { user: ctx.accounts.user.key(), tranche: t as u8, side: s as u8, amount, ready_at });
        Ok(())
    }

    /// Resgata o saque da fila depois do aviso prévio. O valor já estava reservado: não passa pelo disjuntor.
    pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
        ensure_not_frozen(&ctx.accounts.credential)?;
        let now = Clock::get()?.unix_timestamp;
        let ticket = &ctx.accounts.ticket;
        require!(now >= ticket.ready_at, CambiError::WithdrawNotReady);
        let s = side_idx(ticket.side)?;
        let amount = ticket.amount;
        let vaults = [ctx.accounts.brl_vault.amount, ctx.accounts.usd_vault.amount];
        require!(amount <= queue_payable(&ctx.accounts.pool, vaults[s], s), CambiError::QueueCurrencyShort);
        let (vault, dest) = match s {
            BRL => (&ctx.accounts.brl_vault, &ctx.accounts.user_brl),
            _ => (&ctx.accounts.usd_vault, &ctx.accounts.user_usd),
        };
        pay_from_vault(&ctx.accounts.pool, vault, dest, &ctx.accounts.token_program, amount)?;
        let pool = &mut ctx.accounts.pool;
        pool.queued[s] = pool.queued[s].checked_sub(amount).ok_or(CambiError::MathOverflow)?;
        emit!(WithdrawEvent { user: ctx.accounts.user.key(), tranche: u8::MAX, side: s as u8, amount, fees: [0, 0] });
        Ok(())
    }

    /// Fila com a moeda em falta (v2.6): passado o aviso prévio, quem preferir não esperar recebe o mesmo valor na
    /// outra moeda, pelo preço do oráculo e sem taxa. Só vale enquanto a moeda pedida não cobre o pedido (senão
    /// viraria câmbio grátis), e a saída conta no disjuntor da outra moeda.
    pub fn claim_withdraw_other(ctx: Context<ClaimWithdraw>) -> Result<()> {
        ensure_not_frozen(&ctx.accounts.credential)?;
        let now = Clock::get()?.unix_timestamp;
        let ticket = &ctx.accounts.ticket;
        require!(now >= ticket.ready_at, CambiError::WithdrawNotReady);
        let s = side_idx(ticket.side)?;
        let o = 1 - s;
        let amount = ticket.amount;
        let vaults = [ctx.accounts.brl_vault.amount, ctx.accounts.usd_vault.amount];
        require!(amount > queue_payable(&ctx.accounts.pool, vaults[s], s), CambiError::QueueCurrencyAvailable);
        require!(price_fresh(&ctx.accounts.pool, now), CambiError::StalePrice);
        let out = convert_at_price(ctx.accounts.pool.price, s, amount)?;
        let free = [
            swap_available(&ctx.accounts.pool, vaults[BRL], BRL),
            swap_available(&ctx.accounts.pool, vaults[USD], USD),
        ];
        require!(out > 0 && out <= free[o], CambiError::InsufficientLiquidity);
        breaker_take(&mut ctx.accounts.pool, now, free, o, out)?;
        let (vault, dest) = match o {
            BRL => (&ctx.accounts.brl_vault, &ctx.accounts.user_brl),
            _ => (&ctx.accounts.usd_vault, &ctx.accounts.user_usd),
        };
        pay_from_vault(&ctx.accounts.pool, vault, dest, &ctx.accounts.token_program, out)?;
        let pool = &mut ctx.accounts.pool;
        pool.queued[s] = pool.queued[s].checked_sub(amount).ok_or(CambiError::MathOverflow)?;
        emit!(WithdrawEvent { user: ctx.accounts.user.key(), tranche: u8::MAX, side: o as u8, amount: out, fees: [0, 0] });
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

/// Prêmio de escassez do depósito, em bps de cotas a mais. Só para a moeda que falta, calculado pelo desequilíbrio
/// que SOBRA depois do depósito (sem prêmio se o depósito passar do ponto), limitado a MAX_DEPOSIT_PREMIUM_BPS.
/// O principal continua nominal: o prêmio só aumenta a participação nas taxas enquanto o dinheiro fica no pool.
pub fn deposit_premium_bps(pool: &Pool, s: usize, amount: u64, brl_avail: u64, usd_avail: u64) -> u128 {
    let k = (pool.rebalance_k_bps as u128) * DEPOSIT_PREMIUM_MULT;
    let price = pool.price as u128;
    if k == 0 || price == 0 {
        return 0;
    }
    let brl = brl_avail as u128;
    let usd = (usd_avail as u128) * price / PRICE_SCALE;
    let total = brl + usd;
    if total == 0 {
        return 0;
    }
    let imb = ((brl as i128) - (usd as i128)) * (BPS as i128) / (total as i128);
    // Falta dólar (imb > 0): prêmio para depósito em dólar; falta real (imb < 0): para depósito em real.
    let scarce = if imb > 0 { USD } else if imb < 0 { BRL } else { return 0 };
    if s != scarce {
        return 0;
    }
    let add = if s == BRL { amount as u128 } else { (amount as u128) * price / PRICE_SCALE };
    let (brl2, usd2) = if s == BRL { (brl + add, usd) } else { (brl, usd + add) };
    let imb2 = ((brl2 as i128) - (usd2 as i128)) * (BPS as i128) / ((brl2 + usd2) as i128);
    if imb2.signum() != imb.signum() {
        return 0;
    }
    (k * imb2.unsigned_abs() / BPS).min(MAX_DEPOSIT_PREMIUM_BPS)
}

/// Saque imediato só até uma fração da liquidez livre; acima disso, fila com aviso prévio.
pub fn instant_withdraw_ok(available: u64, amount: u64, instant_bps: u16) -> bool {
    (amount as u128) * BPS <= (available as u128) * (instant_bps as u128)
}

/// Disjuntor com janela DESLIZANTE (painel de dados: a janela fixa deixava sair ~2× o teto na virada).
/// A saída somada "escoa" linearmente ao longo da janela. A base (liquidez de referência) cai na hora quando a
/// liquidez cai (ex.: valor que foi para a fila) e só sobe devagar, na velocidade da janela: um depósito grande
/// não infla o teto de uma vez (auditoria, achado 1).
pub fn breaker_roll(pool: &mut Pool, now: i64, free: [u64; 2]) {
    let w = pool.breaker_window_secs.max(1) as u128;
    let e = now.saturating_sub(pool.breaker_start).clamp(0, pool.breaker_window_secs.max(1)) as u128;
    for s in 0..2 {
        let out = (pool.breaker_out[s] as u128) * (w - e) / w;
        pool.breaker_out[s] = out as u64;
        let current = (free[s] as u128) + out;
        let base = pool.breaker_base[s] as u128;
        let next = if current >= base { base + (current - base) * e / w } else { current };
        pool.breaker_base[s] = u64::try_from(next).unwrap_or(u64::MAX);
    }
    pool.breaker_start = now;
}

/// Soma a saída da moeda `s` e recusa se passar do teto (bps da base).
pub fn breaker_take(pool: &mut Pool, now: i64, free: [u64; 2], s: usize, amount: u64) -> Result<()> {
    breaker_roll(pool, now, free);
    let total = pool.breaker_out[s].checked_add(amount).ok_or(CambiError::MathOverflow)?;
    let cap = (pool.breaker_base[s] as u128) * (pool.breaker_bps as u128) / BPS;
    require!((total as u128) <= cap, CambiError::CircuitBreaker);
    pool.breaker_out[s] = total;
    Ok(())
}

/// Entrada de uma moeda abate a saída dela (conta a saída LÍQUIDA).
/// Auditoria v2 (achado 2): trocas de ida e volta não enchem o disjuntor para travar os outros.
pub fn breaker_inflow(pool: &mut Pool, now: i64, free: [u64; 2], s: usize, amount: u64) {
    breaker_roll(pool, now, free);
    pool.breaker_out[s] = pool.breaker_out[s].saturating_sub(amount);
}

/// Saques: a credencial da carteira (endereço fixo por seeds, então não dá para omitir) não pode estar bloqueada.
/// Carteira sem credencial (ex.: pool sem KYC) segue livre.
pub fn ensure_not_frozen(acc: &UncheckedAccount) -> Result<()> {
    if acc.data_is_empty() {
        return Ok(());
    }
    let data = acc.try_borrow_data()?;
    let c = Credential::try_deserialize(&mut &data[..])?;
    require!(!c.frozen, CambiError::AssetsFrozen);
    Ok(())
}

/// Confere a credencial KYC de quem troca ou deposita (quando o pool exige).
pub fn check_credential(pool: &Pool, pool_key: Pubkey, user: Pubkey, cred: Option<&Credential>, value_brl: u128, now: i64) -> Result<()> {
    if !pool.require_kyc {
        return Ok(());
    }
    let c = cred.ok_or(error!(CambiError::KycRequired))?;
    require!(c.pool == pool_key && c.user == user, CambiError::KycRequired);
    require!(!c.frozen, CambiError::AssetsFrozen);
    require!(!c.revoked, CambiError::CredentialRevoked);
    require!(now < c.expires_at, CambiError::CredentialExpired);
    // Auditoria v2 (achado 3): só vale credencial do emissor ATUAL. Trocar o emissor (chave vazada) invalida as antigas.
    let devnet_self = cfg!(feature = "devnet") && c.issuer == c.user && c.level == 1;
    require!(c.issuer == pool.kyc_issuer || devnet_self, CambiError::KycRequired);
    require!((1..=3).contains(&c.level), CambiError::KycRequired);
    let limit = pool.level_limit_brl[(c.level - 1) as usize];
    require!(limit == 0 || value_brl <= limit as u128, CambiError::AboveKycLimit);
    Ok(())
}

/// Reserva atestada cobre o total emitido e o atestado está dentro da validade.
pub fn reserves_ok(supply: u64, reserves: u64, attested_at: i64, now: i64, max_age: i64) -> bool {
    supply <= reserves && now.saturating_sub(attested_at) <= max_age
}

/// Prova de reserva das duas moedas do pool (quando a política está ligada).
pub fn check_backing(pool: &Pool, pool_key: Pubkey, mints: [&Mint; 2], reserves: [Option<&ReserveAttestation>; 2], now: i64) -> Result<()> {
    if pool.reserve_max_age == 0 {
        return Ok(());
    }
    let expected = [pool.brl_mint, pool.usd_mint];
    for s in 0..2 {
        let r = reserves[s].ok_or(error!(CambiError::ReserveUnproven))?;
        require!(r.pool == pool_key && r.mint == expected[s] && r.attester == pool.reserve_attester, CambiError::ReserveUnproven);
        require!(reserves_ok(mints[s].supply, r.reserves, r.attested_at, now, pool.reserve_max_age), CambiError::ReserveUnproven);
    }
    Ok(())
}

/// Soma a operação no teto acumulado de 24 h da credencial (a janela recomeça sozinha).
pub fn use_daily(c: &mut Credential, pool: &Pool, now: i64, value_brl: u128) -> Result<()> {
    if now.saturating_sub(c.day_start) >= 86_400 {
        c.day_start = now;
        c.day_used_brl = 0;
    }
    let value = u64::try_from(value_brl).map_err(|_| error!(CambiError::MathOverflow))?;
    let used = c.day_used_brl.checked_add(value).ok_or(CambiError::MathOverflow)?;
    let limit = pool.level_daily_brl[((c.level.max(1) - 1) as usize).min(2)];
    require!(limit == 0 || used <= limit, CambiError::AboveDailyLimit);
    c.day_used_brl = used;
    Ok(())
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
    let mut amount_out = if s_in == BRL { net * PRICE_SCALE / price } else { net * price / PRICE_SCALE };

    // Desconto para quem REEQUILIBRA (painel de economia e dados): preço melhor proporcional ao desequilíbrio que
    // sobra DEPOIS da troca. Sem desconto se a troca passar do ponto (inverte o lado), e limitado a taxa desta troca
    // + taxa base: a volta (que piora o pool e paga pelo menos a base) nunca dá lucro numa ida e volta.
    let k = pool.rebalance_k_bps as u128;
    if k > 0 && worsens < 0 && total > 0 {
        let (brl2, usd2) = if s_in == BRL {
            (brl + net, usd_in_brl.saturating_sub(amount_out * price / PRICE_SCALE))
        } else {
            (brl.saturating_sub(amount_out), usd_in_brl + net)
        };
        let total2 = brl2 + usd2;
        let imb2: i128 = if total2 == 0 { 0 } else { ((brl2 as i128) - (usd2 as i128)) * (BPS as i128) / (total2 as i128) };
        if imb2.signum() == imb.signum() {
            let bonus_bps = (k * imb2.unsigned_abs() / BPS).min(fee_bps + base_bps);
            amount_out = amount_out * (BPS + bonus_bps) / BPS;
        }
    }

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

/// Trocas respeitam as travas com tempo do guardião: descanso bloqueia tudo; respiro bloqueia só quem tira `s_out`.
pub fn lock_allows_swap(pool: &Pool, now: i64, s_out: usize) -> Result<()> {
    require!(now >= pool.rest_until, CambiError::GuardianResting);
    require!(now >= pool.breathe_until || pool.breathe_side as usize != s_out, CambiError::GuardianBreathing);
    Ok(())
}

/// Aplica uma trava do guardião e devolve até quando ela vale (0 para a pausa total, que não tem hora).
pub fn apply_lock(pool: &mut Pool, now: i64, level: u8, side: u8, secs: i64) -> Result<i64> {
    match level {
        LOCK_BREATHE => {
            let s = side_idx(side)?;
            require!(secs > 0 && secs <= MAX_BREATHE_SECS, CambiError::InvalidLock);
            let until = now.saturating_add(secs);
            // Um respiro novo no outro sentido substitui o anterior; no mesmo sentido, só estende.
            pool.breathe_until = if pool.breathe_side as usize == s { pool.breathe_until.max(until) } else { until };
            pool.breathe_side = s as u8;
            Ok(pool.breathe_until)
        }
        LOCK_REST => {
            require!(secs > 0 && secs <= MAX_REST_SECS, CambiError::InvalidLock);
            if now.saturating_sub(pool.rest_day_start) >= 86_400 {
                pool.rest_day_start = now;
                pool.rest_day_used = 0;
            }
            // Só conta o que estende além do descanso em curso.
            let until = now.saturating_add(secs).max(pool.rest_until);
            let added = until.saturating_sub(pool.rest_until.max(now));
            let used = pool.rest_day_used.saturating_add(added);
            require!(used <= MAX_REST_PER_DAY_SECS, CambiError::InvalidLock);
            pool.rest_day_used = used;
            pool.rest_until = until;
            Ok(until)
        }
        LOCK_STOP => {
            pool.paused = true;
            Ok(0)
        }
        _ => err!(CambiError::InvalidLock),
    }
}

/// Saldo do cofre que pode ser usado em saques de principal (exclui taxas reservadas e a fila de saque).
pub fn available(pool: &Pool, vault_amount: u64, s: usize) -> u64 {
    let reserved = pool.platform_fees[s] + pool.partner_fees[s] + pool.lp_fees_unclaimed[s] + pool.queued[s];
    vault_amount.saturating_sub(reserved)
}

/// Reserva da Rende (v2.6): a parte do principal da Rende, em cada moeda, que as trocas nunca tocam.
/// O resto trabalha nas trocas junto com as Baleias.
pub fn rende_reserve(pool: &Pool, s: usize) -> u64 {
    ((pool.principal[idx(RENDE, s)] as u128) * (pool.rende_reserve_bps as u128) / BPS) as u64
}

/// Liquidez das trocas (v2.6): o que sobra no cofre depois das taxas reservadas, da fila e da reserva da Rende.
pub fn swap_available(pool: &Pool, vault_amount: u64, s: usize) -> u64 {
    available(pool, vault_amount, s).saturating_sub(rende_reserve(pool, s))
}

/// Invariante de lastro (v2.6): cada cofre cobre as taxas reservadas e a reserva da Rende na mesma moeda.
/// (A fila pode esperar a moeda voltar ou ser paga na outra; a reserva e as taxas, nunca.) O programa guardião
/// confere isso a cada vigília; se falhar, é defeito e ele para o pool.
pub fn rende_backed(pool: &Pool, vaults: [u64; 2]) -> bool {
    (0..2).all(|s| {
        let reserved = (pool.platform_fees[s] as u128)
            + (pool.partner_fees[s] as u128)
            + (pool.lp_fees_unclaimed[s] as u128)
            + (rende_reserve(pool, s) as u128);
        (vaults[s] as u128) >= reserved
    })
}

/// Quanto da fila de uma moeda o cofre consegue pagar agora (o saldo menos as taxas reservadas).
pub fn queue_payable(pool: &Pool, vault_amount: u64, s: usize) -> u64 {
    vault_amount.saturating_sub(pool.platform_fees[s] + pool.partner_fees[s] + pool.lp_fees_unclaimed[s])
}

/// Converte um valor de uma moeda para a outra pelo preço do oráculo, sem taxa.
pub fn convert_at_price(price: u64, s: usize, amount: u64) -> Result<u64> {
    let v = if s == BRL {
        (amount as u128) * PRICE_SCALE / (price as u128)
    } else {
        (amount as u128) * (price as u128) / PRICE_SCALE
    };
    u64::try_from(v).map_err(|_| error!(CambiError::MathOverflow))
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
    /// Chave de emergência que só pausa.
    pub guardian: Pubkey,
    /// Quem emite as credenciais KYC (parceiro regulado) e se elas são exigidas.
    pub kyc_issuer: Pubkey,
    pub require_kyc: bool,
    /// Teto por operação, em reais (6 casas), por nível de credencial; 0 = sem teto.
    pub level_limit_brl: [u64; 3],
    /// Disjuntor: janela, teto (bps da liquidez livre no início da janela), base e saída somada por moeda.
    pub breaker_window_secs: i64,
    pub breaker_bps: u16,
    pub breaker_start: i64,
    pub breaker_base: [u64; 2],
    pub breaker_out: [u64; 2],
    /// Saque imediato até esta fração da liquidez livre; acima, fila com aviso prévio.
    pub instant_withdraw_bps: u16,
    pub withdraw_notice_secs: i64,
    /// Valor na fila de saque, reservado nos cofres (fora da liquidez das trocas).
    pub queued: [u64; 2],
    /// Prova de reserva: quem atesta e validade máxima do atestado (0 = desligada).
    pub reserve_attester: Pubkey,
    pub reserve_max_age: i64,
    /// Teto acumulado em 24 h por nível de credencial, em reais (6 casas); 0 = sem teto.
    pub level_daily_brl: [u64; 3],
    /// Desconto para quem reequilibra: bps de preço por 100% de desequilíbrio restante (200 = até 2%).
    pub rebalance_k_bps: u16,
    /// Travas do guardião com hora para acabar (v2.6): descanso total e "respirar" num sentido.
    pub rest_until: i64,
    pub breathe_until: i64,
    pub breathe_side: u8,
    /// Descanso usado no dia corrente (teto MAX_REST_PER_DAY_SECS).
    pub rest_day_start: i64,
    pub rest_day_used: i64,
    /// Parte do principal da Rende guardada 1 para 1 em cada moeda, fora das trocas (bps).
    pub rende_reserve_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct ReserveAttestation {
    pub pool: Pubkey,
    pub mint: Pubkey,
    /// Reserva atestada, em unidades do token (mesmas casas decimais).
    pub reserves: u64,
    pub attested_at: i64,
    pub attester: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Credential {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub issuer: Pubkey,
    /// 1 = básico, 2 = completo, 3 = institucional
    pub level: u8,
    pub expires_at: i64,
    pub revoked: bool,
    pub bump: u8,
    /// Uso acumulado da janela de 24 h (teto diário por nível).
    pub day_start: i64,
    pub day_used_brl: u64,
    /// Indisponibilidade de bens (sanção da ONU/CSNU, ordem judicial): bloqueia troca, depósito e SAQUE.
    pub frozen: bool,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawTicket {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub requested_at: i64,
    pub ready_at: i64,
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
pub struct FreezeEvent {
    pub user: Pubkey,
    pub frozen: bool,
    pub by: Pubkey,
}

#[event]
pub struct ReserveEvent {
    pub mint: Pubkey,
    pub reserves: u64,
    pub supply: u64,
    pub at: i64,
}

#[event]
pub struct GuardianLockEvent {
    pub by: Pubkey,
    /// 0 = travas soltas pelo admin; 1 respirar; 2 descansar; 3 parar.
    pub level: u8,
    pub side: u8,
    pub until: i64,
    /// Motivo informado pelo guardião (código do programa guardião).
    pub reason: u8,
}

#[event]
pub struct PauseEvent {
    pub by: Pubkey,
    pub paused: bool,
}

#[event]
pub struct CredentialEvent {
    pub user: Pubkey,
    pub level: u8,
    pub expires_at: i64,
    pub revoked: bool,
}

#[event]
pub struct WithdrawRequestedEvent {
    pub user: Pubkey,
    pub tranche: u8,
    pub side: u8,
    pub amount: u64,
    pub ready_at: i64,
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
pub struct AttestReserves<'info> {
    #[account(mut)]
    pub attester: Signer<'info>,
    #[account(constraint = pool.reserve_attester == attester.key() @ CambiError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed, payer = attester, space = 8 + ReserveAttestation::INIT_SPACE,
        seeds = [b"reserve", pool.key().as_ref(), mint.key().as_ref()], bump
    )]
    pub reserve: Account<'info, ReserveAttestation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GuardianPause<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, has_one = guardian)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct IssueCredential<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(constraint = pool.kyc_issuer == issuer.key() @ CambiError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    /// CHECK: carteira que recebe a credencial; só usada como chave.
    pub user: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = issuer, space = 8 + Credential::INIT_SPACE,
        seeds = [b"credential", pool.key().as_ref(), user.key().as_ref()], bump
    )]
    pub credential: Account<'info, Credential>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RestoreCredential<'info> {
    pub admin: Signer<'info>,
    #[account(has_one = admin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub credential: Account<'info, Credential>,
}

#[derive(Accounts)]
pub struct RemovePartner<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(has_one = admin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool, close = admin)]
    pub partner: Account<'info, Partner>,
}

#[derive(Accounts)]
pub struct RevokeCredential<'info> {
    pub authority: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub credential: Account<'info, Credential>,
}

#[cfg(feature = "devnet")]
#[derive(Accounts)]
pub struct DevnetCredential<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed, payer = user, space = 8 + Credential::INIT_SPACE,
        seeds = [b"credential", pool.key().as_ref(), user.key().as_ref()], bump
    )]
    pub credential: Account<'info, Credential>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut, has_one = pool,
        constraint = position.owner == user.key() @ CambiError::InvalidPosition,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref(), &[position.tranche], &[position.side]],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    /// Um pedido por posição de cada vez.
    #[account(
        init, payer = user, space = 8 + WithdrawTicket::INIT_SPACE,
        seeds = [b"ticket", position.key().as_ref()], bump
    )]
    pub ticket: Box<Account<'info, WithdrawTicket>>,
    #[account(mut)]
    pub brl_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub usd_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Box<Account<'info, TokenAccount>>,
    /// CHECK: credencial da carteira no endereço fixo (seeds); se existir, não pode estar bloqueada.
    #[account(seeds = [b"credential", pool.key().as_ref(), user.key().as_ref()], bump)]
    pub credential: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, constraint = ticket.owner == user.key() @ CambiError::InvalidPosition, close = user)]
    pub ticket: Box<Account<'info, WithdrawTicket>>,
    #[account(mut)]
    pub brl_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub usd_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Box<Account<'info, TokenAccount>>,
    /// CHECK: credencial da carteira no endereço fixo (seeds); se existir, não pode estar bloqueada.
    #[account(seeds = [b"credential", pool.key().as_ref(), user.key().as_ref()], bump)]
    pub credential: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
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
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref(), &[tranche], &[side]], bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut)]
    pub brl_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub usd_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Box<Account<'info, TokenAccount>>,
    /// Credencial KYC da carteira (exigida quando `pool.require_kyc`); guarda o uso acumulado do dia.
    #[account(mut)]
    pub credential: Option<Box<Account<'info, Credential>>>,
    #[account(address = pool.brl_mint)]
    pub brl_mint: Box<Account<'info, Mint>>,
    #[account(address = pool.usd_mint)]
    pub usd_mint: Box<Account<'info, Mint>>,
    /// Atestados de reserva das duas moedas (exigidos quando a prova de reserva está ligada).
    pub brl_reserve: Option<Box<Account<'info, ReserveAttestation>>>,
    pub usd_reserve: Option<Box<Account<'info, ReserveAttestation>>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut, has_one = pool,
        constraint = position.owner == user.key() @ CambiError::InvalidPosition,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref(), &[position.tranche], &[position.side]],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut)]
    pub brl_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub usd_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Box<Account<'info, TokenAccount>>,
    /// CHECK: credencial da carteira no endereço fixo (seeds); se existir, não pode estar bloqueada.
    #[account(seeds = [b"credential", pool.key().as_ref(), user.key().as_ref()], bump)]
    pub credential: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut, has_one = brl_vault, has_one = usd_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub brl_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub usd_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.brl_mint, token::authority = user)]
    pub user_brl: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.usd_mint, token::authority = user)]
    pub user_usd: Box<Account<'info, TokenAccount>>,
    pub depositor_position: Option<Box<Account<'info, Position>>>,
    pub partner: Option<Box<Account<'info, Partner>>>,
    /// Credencial KYC da carteira (exigida quando `pool.require_kyc`, exceto para app parceiro); guarda o uso do dia.
    #[account(mut)]
    pub credential: Option<Box<Account<'info, Credential>>>,
    #[account(address = pool.brl_mint)]
    pub brl_mint: Box<Account<'info, Mint>>,
    #[account(address = pool.usd_mint)]
    pub usd_mint: Box<Account<'info, Mint>>,
    /// Atestados de reserva das duas moedas (exigidos quando a prova de reserva está ligada).
    pub brl_reserve: Option<Box<Account<'info, ReserveAttestation>>>,
    pub usd_reserve: Option<Box<Account<'info, ReserveAttestation>>>,
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
    #[msg("Carteira sem credencial de identidade (KYC) neste pool")]
    KycRequired,
    #[msg("Credencial de identidade revogada")]
    CredentialRevoked,
    #[msg("Credencial de identidade vencida; renove a verificação")]
    CredentialExpired,
    #[msg("Valor acima do limite do seu nível de verificação")]
    AboveKycLimit,
    #[msg("Disjuntor: o pool atingiu o teto de saída desta janela; tente mais tarde")]
    CircuitBreaker,
    #[msg("Saque grande: use a fila de saque (aviso prévio)")]
    UseWithdrawQueue,
    #[msg("Saque da fila ainda no prazo de aviso prévio")]
    WithdrawNotReady,
    #[msg("Lastro sem prova: reserva atestada menor que o emitido ou atestado vencido")]
    ReserveUnproven,
    #[msg("Limite diário do seu nível de verificação atingido; tente amanhã ou suba de nível")]
    AboveDailyLimit,
    #[msg("Bens indisponíveis por determinação legal; fale com o atendimento")]
    AssetsFrozen,
    #[msg("Depósito na Baleia exige credencial institucional (nível 3)")]
    BaleiaNeedsLevel3,
    #[msg("Guardião em descanso: trocas e depósitos voltam sozinhos em poucos minutos; saques seguem liberados")]
    GuardianResting,
    #[msg("Guardião pediu respiro: esta moeda está saindo rápido demais; a troca no sentido contrário segue liberada")]
    GuardianBreathing,
    #[msg("Trava do guardião inválida (nível, moeda, tempo ou teto diário)")]
    InvalidLock,
    #[msg("A moeda do seu saque ainda está em falta: espere ela voltar ou receba o mesmo valor na outra moeda")]
    QueueCurrencyShort,
    #[msg("A moeda do seu saque já está disponível: resgate nela")]
    QueueCurrencyAvailable,
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
            guardian: Pubkey::default(),
            kyc_issuer: Pubkey::default(),
            require_kyc: true,
            level_limit_brl: DEFAULT_LEVEL_LIMITS,
            breaker_window_secs: DEFAULT_BREAKER_WINDOW_SECS,
            breaker_bps: DEFAULT_BREAKER_BPS,
            breaker_start: 0,
            breaker_base: [0; 2],
            breaker_out: [0; 2],
            instant_withdraw_bps: DEFAULT_INSTANT_WITHDRAW_BPS,
            withdraw_notice_secs: DEFAULT_WITHDRAW_NOTICE_SECS,
            queued: [0; 2],
            reserve_attester: Pubkey::default(),
            reserve_max_age: 0,
            level_daily_brl: DEFAULT_DAILY_LIMITS,
            rebalance_k_bps: 0,
            rest_until: 0,
            breathe_until: 0,
            breathe_side: 0,
            rest_day_start: 0,
            rest_day_used: 0,
            rende_reserve_bps: DEFAULT_RENDE_RESERVE_BPS,
        }
    }

    fn cred(level: u8, expires_at: i64, revoked: bool) -> Credential {
        // Emissor = Pubkey::default() = pool.kyc_issuer nos testes.
        Credential { pool: Pubkey::default(), user: Pubkey::default(), issuer: Pubkey::default(), level, expires_at, revoked, bump: 0, day_start: 0, day_used_brl: 0, frozen: false }
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

    #[test]
    fn kyc_exige_credencial_valida_e_respeita_o_teto_do_nivel() {
        let p = pool(5_000_000);
        let k = Pubkey::default();
        let now = 1_000;
        assert!(check_credential(&p, k, k, None, 1, now).is_err()); // sem credencial
        assert!(check_credential(&p, k, k, Some(&cred(1, 2_000, false)), 1_000 * R as u128, now).is_ok());
        assert!(check_credential(&p, k, k, Some(&cred(1, 2_000, true)), 1, now).is_err()); // revogada
        assert!(check_credential(&p, k, k, Some(&cred(1, 900, false)), 1, now).is_err()); // vencida
        // Nível básico: até R$ 10 mil por operação; institucional sem teto.
        assert!(check_credential(&p, k, k, Some(&cred(1, 2_000, false)), 10_001 * R as u128, now).is_err());
        assert!(check_credential(&p, k, k, Some(&cred(3, 2_000, false)), 10_000_000 * R as u128, now).is_ok());
        // Pool sem exigência (ex.: rede de testes aberta) aceita sem credencial.
        let mut aberto = pool(5_000_000);
        aberto.require_kyc = false;
        assert!(check_credential(&aberto, k, k, None, 1, now).is_ok());
        // Credencial de outra carteira não serve.
        let outra = Pubkey::new_unique();
        assert!(check_credential(&p, k, outra, Some(&cred(1, 2_000, false)), 1, now).is_err());
    }

    #[test]
    fn disjuntor_janela_deslizante() {
        let mut p = pool(5_000_000);
        // 30% de R$ 1.000 livres: R$ 300 saem; o próximo real é recusado.
        assert!(breaker_take(&mut p, 10_000, [1_000 * R, 200 * R], BRL, 300 * R).is_ok());
        assert!(breaker_take(&mut p, 10_000, [700 * R, 200 * R], BRL, 1).is_err());
        // A outra moeda tem o próprio teto.
        assert!(breaker_take(&mut p, 10_000, [700 * R, 200 * R], USD, 60 * R).is_ok());
        // Meia janela depois, metade da saída "escoou": cabe só mais um pouco, não um teto inteiro novo.
        let half = 10_000 + DEFAULT_BREAKER_WINDOW_SECS / 2;
        assert!(breaker_take(&mut p, half, [700 * R, 140 * R], BRL, 100 * R).is_ok());
        assert!(breaker_take(&mut p, half, [600 * R, 140 * R], BRL, 10 * R).is_err());
    }

    #[test]
    fn desconto_para_quem_reequilibra_sem_lucro_na_ida_e_volta() {
        let mut p = pool(5_000_000);
        p.rebalance_k_bps = 200;
        // Sobra real (R$ 900 mil x US$ 50 mil = R$ 250 mil): quem traz dólar recebe preço melhor.
        let sem = { let mut q = pool(5_000_000); q.rebalance_k_bps = 0; quote(&q, USD, 1_000 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap() };
        let com = quote(&p, USD, 1_000 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap();
        assert!(com.amount_out > sem.amount_out);
        // Quem piora o pool não ganha desconto.
        let piora_sem = { let mut q = pool(5_000_000); q.rebalance_k_bps = 0; quote(&q, BRL, 1_000 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap() };
        let piora = quote(&p, BRL, 1_000 * R, UserKind::Retail, 900_000 * R, 50_000 * R).unwrap();
        assert_eq!(piora.amount_out, piora_sem.amount_out);
        // Ida e volta: entra US$ 1.000, sai em real, volta para dólar. Termina com menos dólar.
        let ida = quote(&p, USD, 1_000 * R, UserKind::Depositor, 900_000 * R, 50_000 * R).unwrap();
        let volta = quote(&p, BRL, ida.amount_out, UserKind::Depositor, 900_000 * R - ida.amount_out, 51_000 * R).unwrap();
        assert!(volta.amount_out < 1_000 * R);
    }

    #[test]
    fn auditoria_base_do_disjuntor_nao_infla_e_ida_e_volta_nao_trava() {
        // Achado 1: base cai na hora quando a liquidez cai (R$ 2.000 foram para a fila) e só sobe devagar.
        let mut p = pool(5_000_000);
        assert!(breaker_take(&mut p, 10_000, [3_000 * R, 600 * R], BRL, 1).is_ok());
        assert!(breaker_take(&mut p, 10_010, [1_000 * R, 600 * R], BRL, 400 * R).is_err());
        assert!(breaker_take(&mut p, 10_010, [1_000 * R, 600 * R], BRL, 290 * R).is_ok());
        // Depósito grande (de R$ 710 para R$ 10.000 livres) não infla o teto no mesmo instante.
        assert!(breaker_take(&mut p, 10_010, [10_000 * R, 600 * R], BRL, 100 * R).is_err());
        // Achado 2: a entrada de real abate a saída de real (ida e volta não enche o disjuntor).
        breaker_inflow(&mut p, 10_020, [710 * R, 600 * R], BRL, 291 * R);
        assert_eq!(p.breaker_out[BRL], 0);
        assert!(breaker_take(&mut p, 10_030, [1_000 * R, 600 * R], BRL, 250 * R).is_ok());
    }

    #[test]
    fn premio_de_escassez_so_para_a_moeda_que_falta() {
        let mut p = pool(5_000_000);
        p.rebalance_k_bps = 200;
        // Sobra real (R$ 150 mil x US$ 20 mil = R$ 100 mil): quem deposita dólar ganha cotas a mais.
        let dolar = deposit_premium_bps(&p, USD, 1_000 * R, 150_000 * R, 20_000 * R);
        assert!(dolar > 0 && dolar <= MAX_DEPOSIT_PREMIUM_BPS);
        // ~20% de desequilíbrio depois do depósito, k × 5 = 10% por 100%: ~2% de cotas a mais.
        assert!((150..=250).contains(&dolar));
        // Real (a moeda que sobra) não ganha prêmio.
        assert_eq!(deposit_premium_bps(&p, BRL, 1_000 * R, 150_000 * R, 20_000 * R), 0);
        // Depósito que passa do ponto (inverte o lado) não ganha prêmio.
        assert_eq!(deposit_premium_bps(&p, USD, 100_000 * R, 150_000 * R, 20_000 * R), 0);
        // Pool equilibrado: sem prêmio.
        assert_eq!(deposit_premium_bps(&p, USD, 1_000 * R, 100_000 * R, 20_000 * R), 0);
        // Desligado com k = 0.
        p.rebalance_k_bps = 0;
        assert_eq!(deposit_premium_bps(&p, USD, 1_000 * R, 150_000 * R, 20_000 * R), 0);
    }

    #[test]
    fn credencial_bloqueada_nao_troca() {
        let p = pool(5_000_000);
        let k = Pubkey::default();
        let mut c = cred(3, 2_000, false);
        c.frozen = true;
        assert!(check_credential(&p, k, k, Some(&c), 1, 1_000).is_err());
    }

    #[test]
    fn teto_diario_soma_operacoes_e_reabre_em_24h() {
        let p = pool(5_000_000);
        let mut c = cred(1, 1_000_000, false);
        // Nível básico: R$ 30 mil por dia, mesmo em operações de R$ 10 mil.
        for _ in 0..3 {
            assert!(use_daily(&mut c, &p, 1_000, (10_000 * R) as u128).is_ok());
        }
        assert!(use_daily(&mut c, &p, 2_000, 1).is_err());
        assert!(use_daily(&mut c, &p, 1_000 + 86_400, (10_000 * R) as u128).is_ok());
    }

    #[test]
    fn auditoria_credencial_de_emissor_antigo_nao_vale() {
        let mut p = pool(5_000_000);
        let k = Pubkey::default();
        assert!(check_credential(&p, k, k, Some(&cred(3, 2_000, false)), 1, 1_000).is_ok());
        p.kyc_issuer = Pubkey::new_unique(); // emissor trocado
        assert!(check_credential(&p, k, k, Some(&cred(3, 2_000, false)), 1, 1_000).is_err());
    }

    #[test]
    fn saque_grande_vai_para_a_fila_e_o_valor_da_fila_fica_reservado() {
        assert!(instant_withdraw_ok(1_000, 100, 1_000)); // 10%
        assert!(!instant_withdraw_ok(1_000, 101, 1_000));
        let mut p = pool(5_000_000);
        p.queued[BRL] = 400;
        assert_eq!(available(&p, 1_000, BRL), 600);
    }

    #[test]
    fn prova_de_reserva_trava_moeda_sem_lastro_ou_com_atestado_velho() {
        assert!(reserves_ok(1_000, 1_000, 100, 200, 3_600));
        assert!(!reserves_ok(1_001, 1_000, 100, 200, 3_600)); // emitiu mais do que tem
        assert!(!reserves_ok(1_000, 1_000, 100, 100 + 3_601, 3_600)); // atestado vencido
    }

    #[test]
    fn respirar_bloqueia_so_o_sentido_que_drena_e_solta_pelo_tempo() {
        let mut p = pool(5 * R);
        let until = apply_lock(&mut p, 1_000, LOCK_BREATHE, USD as u8, 15 * 60).unwrap();
        assert_eq!(until, 1_000 + 900);
        assert!(lock_allows_swap(&p, 1_100, USD).is_err()); // quem tira dólar espera
        assert!(lock_allows_swap(&p, 1_100, BRL).is_ok()); // quem traz dólar (tira real) passa
        assert!(lock_allows_swap(&p, 1_900, USD).is_ok()); // passou o tempo: solta sozinho
        assert!(apply_lock(&mut p, 1_000, LOCK_BREATHE, USD as u8, MAX_BREATHE_SECS + 1).is_err());
        assert!(apply_lock(&mut p, 1_000, LOCK_BREATHE, 7, 60).is_err());
    }

    #[test]
    fn descansar_para_tudo_e_tem_teto_diario() {
        let mut p = pool(5 * R);
        let until = apply_lock(&mut p, 10_000, LOCK_REST, 0, 3_600).unwrap();
        assert!(lock_allows_swap(&p, 10_100, BRL).is_err());
        assert!(lock_allows_swap(&p, 10_100, USD).is_err());
        assert!(lock_allows_swap(&p, until, USD).is_ok());
        // Estender um descanso em curso conta só o tempo a mais.
        apply_lock(&mut p, 10_100, LOCK_REST, 0, 3_600).unwrap();
        assert_eq!(p.rest_day_used, 3_600 + 100);
        // Teto de 6 h por dia: não passa disso, nem em pedaços.
        let mut t = 20_000;
        let mut ok = 0;
        while apply_lock(&mut p, t, LOCK_REST, 0, MAX_REST_SECS).is_ok() {
            ok += 1;
            t += MAX_REST_SECS + 1;
        }
        assert!(p.rest_day_used <= MAX_REST_PER_DAY_SECS);
        assert!(ok >= 1);
        // No dia seguinte, o teto renova.
        assert!(apply_lock(&mut p, 10_000 + 86_400, LOCK_REST, 0, 600).is_ok());
        assert!(apply_lock(&mut p, 0, LOCK_REST, 0, MAX_REST_SECS + 1).is_err());
    }

    #[test]
    fn parar_pausa_sem_hora_para_acabar() {
        let mut p = pool(5 * R);
        assert_eq!(apply_lock(&mut p, 1, LOCK_STOP, 0, 0).unwrap(), 0);
        assert!(p.paused);
        assert!(apply_lock(&mut p, 1, 9, 0, 60).is_err());
    }

    #[test]
    fn reserva_da_rende_fica_fora_das_trocas() {
        let mut p = pool(5 * R);
        p.principal[idx(RENDE, BRL)] = 1_000 * R;
        p.rende_reserve_bps = 3_000;
        // Cofre com R$ 1.500: R$ 300 são a reserva da Rende; as trocas enxergam R$ 1.200.
        assert_eq!(swap_available(&p, 1_500 * R, BRL), 1_200 * R);
        assert_eq!(available(&p, 1_500 * R, BRL), 1_500 * R);
        assert!(rende_backed(&p, [300 * R, 0]));
        assert!(!rende_backed(&p, [299 * R, 0]));
        p.rende_reserve_bps = 10_000;
        assert_eq!(swap_available(&p, 1_500 * R, BRL), 500 * R);
    }

    #[test]
    fn fila_com_moeda_em_falta_espera_ou_recebe_na_outra() {
        let mut p = pool(5 * R);
        p.queued[BRL] = 1_000 * R;
        p.lp_fees_unclaimed[BRL] = 10 * R;
        // Cofre de real com R$ 600: paga só R$ 590 da fila (as taxas são de outros).
        assert_eq!(queue_payable(&p, 600 * R, BRL), 590 * R);
        assert_eq!(available(&p, 600 * R, BRL), 0); // trocas que tiram real param
        // Na outra moeda, pelo preço: R$ 1.000 a R$ 5 por dólar = US$ 200.
        assert_eq!(convert_at_price(5 * R, BRL, 1_000 * R).unwrap(), 200 * R);
        assert_eq!(convert_at_price(5 * R, USD, 200 * R).unwrap(), 1_000 * R);
        // A fila não entra no invariante: só taxas e reserva da Rende.
        assert!(rende_backed(&p, [600 * R, 0]));
    }
}
