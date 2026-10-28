//! cambI guardião: programa SEM CHAVE que vigia o pool e aciona travas.
//!
//! Qualquer pessoa (um robô, o app antes de uma troca, um usuário) chama `vigiar`. O programa lê o pool na
//! blockchain, compara com a foto da vigília anterior e decide sozinho, por regras públicas:
//! - nível 3 "parar": o cofre não cobre as taxas reservadas e a reserva da Rende, ou o colchão das Baleias ficou
//!   fino demais perto do que é devido à Rende. Pausa total; só o conselho (admin do pool) solta.
//! - nível 2 "descansar": a cotação saltou mais que o limite entre duas vigílias (oráculo suspeito), ou o
//!   "respirar" disparou várias vezes no mesmo dia. Trocas e depósitos param por um tempo e voltam sozinhos.
//! - nível 1 "respirar": a liquidez das trocas de uma moeda caiu 20% ou mais numa janela curta. Só as trocas que
//!   tiram essa moeda param; quem traz a moeda continua trocando. Volta sozinho.
//! Saques nunca são bloqueados. O guardião não mexe em dinheiro, preço, taxas nem regras, e o próprio pool
//! limita quanto tempo ele pode travar por dia.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use cambi_pool::{Pool, BALEIA, BPS, BRL, PRICE_SCALE, RENDE, USD};

declare_id!("AjmN13L2r1Kx5YVf5b93Wu3aqjkVkYaewaStqFPiXeRR");

/// Queda da liquidez das trocas de uma moeda, dentro da janela, que dispara o "respirar" (20%).
pub const BREATHE_DROP_BPS: u128 = 2_000;
/// Janela de comparação: a foto base é renovada a cada 15 min.
pub const WINDOW_SECS: i64 = 15 * 60;
/// Vigília depois de muito tempo não julga a saída (fluxo lento não é corrida); só renova a foto.
pub const JUDGE_MAX_SECS: i64 = 30 * 60;
pub const BREATHE_SECS: i64 = 15 * 60;
/// Salto de cotação entre duas vigílias que dispara o "descansar" (3%; o pool aceita até 10% por atualização).
pub const PRICE_JUMP_BPS: u128 = 300;
pub const REST_SECS: i64 = 3_600;
/// Quantos "respirar" no mesmo dia viram um "descansar".
pub const STRIKES_FOR_REST: u8 = 3;
/// Colchão mínimo das Baleias: o patrimônio delas precisa ser pelo menos 10% do que é devido à Rende.
pub const MIN_CUSHION_BPS: u128 = 1_000;

pub const REASON_FAST_OUTFLOW: u8 = 1;
pub const REASON_PRICE_JUMP: u8 = 2;
pub const REASON_REPEATED: u8 = 3;
pub const REASON_UNBACKED: u8 = 4;
pub const REASON_THIN_CUSHION: u8 = 5;

#[program]
pub mod cambi_guardian {
    use super::*;

    /// Cria a ficha de vigília de um pool, com a primeira foto. Qualquer pessoa pode criar.
    pub fn init_watch(ctx: Context<InitWatch>) -> Result<()> {
        let pool = load_pool(&ctx.accounts.pool)?;
        let vaults = vault_amounts(&pool, &ctx.accounts.brl_vault, &ctx.accounts.usd_vault)?;
        let now = Clock::get()?.unix_timestamp;
        let w = &mut ctx.accounts.watch;
        w.pool = ctx.accounts.pool.key();
        w.window_start = now;
        w.base_avail = swap_avail(&pool, vaults);
        w.last_price = pool.price;
        w.day_start = now;
        w.strikes = 0;
        w.vigils = 0;
        w.locks = 0;
        w.bump = ctx.bumps.watch;
        Ok(())
    }

    /// Vigília: lê o pool, decide e, se for o caso, aciona a trava no pool assinando como guardião (PDA).
    pub fn vigiar(ctx: Context<Vigiar>) -> Result<()> {
        let pool = load_pool(&ctx.accounts.pool)?;
        let vaults = vault_amounts(&pool, &ctx.accounts.brl_vault, &ctx.accounts.usd_vault)?;
        let now = Clock::get()?.unix_timestamp;
        let view = PoolView::read(&pool, vaults);

        let w = &mut ctx.accounts.watch;
        if now.saturating_sub(w.day_start) >= 86_400 {
            w.day_start = now;
            w.strikes = 0;
        }
        let snap = Snapshot { window_start: w.window_start, base_avail: w.base_avail, last_price: w.last_price, strikes: w.strikes };
        let d = decide(&snap, &view, now);

        // Não repete uma trava que já está valendo (e não gasta o teto diário de descanso à toa).
        let already = match d.level {
            1 => pool.breathe_until > now && pool.breathe_side == d.side,
            2 => pool.rest_until > now,
            3 => pool.paused,
            _ => true,
        };
        if d.level == 1 {
            w.strikes = w.strikes.saturating_add(1);
        }
        if !already {
            let pool_key = ctx.accounts.pool.key();
            let seeds: &[&[u8]] = &[b"guardian", pool_key.as_ref(), &[ctx.bumps.guardian]];
            cambi_pool::cpi::guardian_lock(
                CpiContext::new_with_signer(
                    ctx.accounts.cambi_pool_program.to_account_info(),
                    cambi_pool::cpi::accounts::GuardianPause {
                        guardian: ctx.accounts.guardian.to_account_info(),
                        pool: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                d.level,
                d.side,
                d.secs,
                d.reason,
            )?;
            w.locks = w.locks.saturating_add(1);
        }

        // Nova foto: a base da janela renova a cada WINDOW_SECS; o preço, a cada vigília.
        if now.saturating_sub(w.window_start) >= WINDOW_SECS {
            w.window_start = now;
            w.base_avail = view.swap_avail;
        }
        w.last_price = pool.price;
        w.vigils = w.vigils.saturating_add(1);
        emit!(VigilEvent { pool: ctx.accounts.pool.key(), level: d.level, side: d.side, secs: d.secs, reason: d.reason, applied: !already && d.level > 0 });
        Ok(())
    }
}

/// O que o guardião enxerga do pool numa vigília.
#[derive(Clone, Copy, Debug, Default)]
pub struct PoolView {
    pub price: u64,
    pub swap_avail: [u64; 2],
    /// Cofres cobrem as taxas reservadas e a reserva da Rende em cada moeda.
    pub backed: bool,
    /// Patrimônio das Baleias e o devido à Rende, em reais (6 casas); `has_baleias` = existe camada júnior.
    pub baleia_equity_brl: i128,
    pub rende_owed_brl: u128,
    pub has_baleias: bool,
}

impl PoolView {
    pub fn read(pool: &Pool, vaults: [u64; 2]) -> Self {
        let price = pool.price as u128;
        let value = |s: usize, v: u128| if s == BRL { v } else { v * price / PRICE_SCALE };
        let mut assets: u128 = 0;
        let mut reserved: u128 = 0;
        let mut rende: u128 = 0;
        for s in [BRL, USD] {
            assets += value(s, vaults[s] as u128);
            reserved += value(
                s,
                pool.platform_fees[s] as u128 + pool.partner_fees[s] as u128 + pool.lp_fees_unclaimed[s] as u128 + pool.queued[s] as u128,
            );
            rende += value(s, pool.principal[cambi_pool::idx(RENDE, s)] as u128);
        }
        PoolView {
            price: pool.price,
            swap_avail: swap_avail(pool, vaults),
            backed: cambi_pool::rende_backed(pool, vaults),
            baleia_equity_brl: assets as i128 - reserved as i128 - rende as i128,
            rende_owed_brl: rende,
            has_baleias: pool.shares[BALEIA] > 0,
        }
    }
}

/// Foto da vigília anterior.
#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
    pub window_start: i64,
    pub base_avail: [u64; 2],
    pub last_price: u64,
    pub strikes: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Decision {
    /// 0 = tudo certo; 1 respirar; 2 descansar; 3 parar.
    pub level: u8,
    pub side: u8,
    pub secs: i64,
    pub reason: u8,
}

/// A decisão do guardião, pura (sem contas), para ser testada fora da blockchain. O nível mais grave vence.
pub fn decide(snap: &Snapshot, view: &PoolView, now: i64) -> Decision {
    if !view.backed {
        return Decision { level: 3, side: 0, secs: 0, reason: REASON_UNBACKED };
    }
    if view.has_baleias && view.rende_owed_brl > 0 && view.baleia_equity_brl * (BPS as i128) < (view.rende_owed_brl * MIN_CUSHION_BPS) as i128 {
        return Decision { level: 3, side: 0, secs: 0, reason: REASON_THIN_CUSHION };
    }
    if snap.last_price > 0 {
        let (a, b) = (view.price as u128, snap.last_price as u128);
        let jump = a.abs_diff(b) * BPS / b;
        if jump >= PRICE_JUMP_BPS {
            return Decision { level: 2, side: 0, secs: REST_SECS, reason: REASON_PRICE_JUMP };
        }
    }
    let elapsed = now.saturating_sub(snap.window_start);
    if elapsed <= JUDGE_MAX_SECS {
        // A moeda que mais caiu, se caiu 20% ou mais.
        let mut worst: Option<(usize, u128)> = None;
        for s in [BRL, USD] {
            let base = snap.base_avail[s] as u128;
            let cur = view.swap_avail[s] as u128;
            if base > 0 && cur < base {
                let drop = (base - cur) * BPS / base;
                if drop >= BREATHE_DROP_BPS && worst.map_or(true, |(_, d)| drop > d) {
                    worst = Some((s, drop));
                }
            }
        }
        if let Some((s, _)) = worst {
            if snap.strikes.saturating_add(1) >= STRIKES_FOR_REST {
                return Decision { level: 2, side: 0, secs: REST_SECS, reason: REASON_REPEATED };
            }
            return Decision { level: 1, side: s as u8, secs: BREATHE_SECS, reason: REASON_FAST_OUTFLOW };
        }
    }
    Decision::default()
}

fn swap_avail(pool: &Pool, vaults: [u64; 2]) -> [u64; 2] {
    [cambi_pool::swap_available(pool, vaults[BRL], BRL), cambi_pool::swap_available(pool, vaults[USD], USD)]
}

/// Lê a conta do pool, conferindo que pertence ao programa do pool.
fn load_pool(info: &UncheckedAccount) -> Result<Pool> {
    require_keys_eq!(*info.owner, cambi_pool::ID, GuardianError::NotAPool);
    let data = info.try_borrow_data()?;
    Pool::try_deserialize(&mut &data[..]).map_err(|_| error!(GuardianError::NotAPool))
}

fn vault_amounts(pool: &Pool, brl: &Account<TokenAccount>, usd: &Account<TokenAccount>) -> Result<[u64; 2]> {
    require_keys_eq!(brl.key(), pool.brl_vault, GuardianError::WrongVault);
    require_keys_eq!(usd.key(), pool.usd_vault, GuardianError::WrongVault);
    Ok([brl.amount, usd.amount])
}

#[account]
#[derive(InitSpace)]
pub struct Watch {
    pub pool: Pubkey,
    pub window_start: i64,
    pub base_avail: [u64; 2],
    pub last_price: u64,
    pub day_start: i64,
    pub strikes: u8,
    pub vigils: u64,
    pub locks: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitWatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: conferido em load_pool (dono = programa do pool, dados de Pool).
    pub pool: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Watch::INIT_SPACE, seeds = [b"watch", pool.key().as_ref()], bump)]
    pub watch: Account<'info, Watch>,
    pub brl_vault: Account<'info, TokenAccount>,
    pub usd_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Vigiar<'info> {
    #[account(mut, seeds = [b"watch", pool.key().as_ref()], bump = watch.bump, has_one = pool)]
    pub watch: Account<'info, Watch>,
    /// CHECK: conferido em load_pool; gravável porque a trava é escrita pelo programa do pool (CPI).
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    pub brl_vault: Account<'info, TokenAccount>,
    pub usd_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA do guardião; é o endereço gravado como guardião no pool e só assina por este programa.
    #[account(seeds = [b"guardian", pool.key().as_ref()], bump)]
    pub guardian: UncheckedAccount<'info>,
    pub cambi_pool_program: Program<'info, cambi_pool::program::CambiPool>,
}

#[event]
pub struct VigilEvent {
    pub pool: Pubkey,
    pub level: u8,
    pub side: u8,
    pub secs: i64,
    pub reason: u8,
    /// false quando a mesma trava já estava valendo.
    pub applied: bool,
}

#[error_code]
pub enum GuardianError {
    #[msg("Conta não é um pool do cambI")]
    NotAPool,
    #[msg("Cofre não é o do pool")]
    WrongVault,
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: u64 = 1_000_000;

    fn view(brl: u64, usd: u64) -> PoolView {
        PoolView { price: 5 * R, swap_avail: [brl, usd], backed: true, baleia_equity_brl: 100_000 * R as i128, rende_owed_brl: 100_000 * R as u128, has_baleias: true }
    }
    fn snap(brl: u64, usd: u64) -> Snapshot {
        Snapshot { window_start: 1_000, base_avail: [brl, usd], last_price: 5 * R, strikes: 0 }
    }

    #[test]
    fn uso_normal_nao_trava() {
        let d = decide(&snap(10_000 * R, 2_000 * R), &view(9_000 * R, 1_700 * R), 1_300);
        assert_eq!(d.level, 0);
    }

    #[test]
    fn saida_de_20_por_cento_na_janela_faz_respirar_so_naquela_moeda() {
        let d = decide(&snap(10_000 * R, 2_000 * R), &view(10_500 * R, 1_600 * R), 1_300);
        assert_eq!(d, Decision { level: 1, side: USD as u8, secs: BREATHE_SECS, reason: REASON_FAST_OUTFLOW });
        // Mesma queda vista depois de muito tempo: fluxo lento, não julga.
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &view(10_500 * R, 1_600 * R), 1_000 + JUDGE_MAX_SECS + 1).level, 0);
    }

    #[test]
    fn reincidencia_no_dia_vira_descanso() {
        let mut s = snap(10_000 * R, 2_000 * R);
        s.strikes = STRIKES_FOR_REST - 1;
        let d = decide(&s, &view(10_000 * R, 1_500 * R), 1_300);
        assert_eq!(d, Decision { level: 2, side: 0, secs: REST_SECS, reason: REASON_REPEATED });
    }

    #[test]
    fn salto_de_cotacao_faz_descansar() {
        let mut v = view(10_000 * R, 2_000 * R);
        v.price = 5 * R + 5 * R * 3 / 100; // +3%
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).reason, REASON_PRICE_JUMP);
        v.price = 5 * R + 5 * R * 2 / 100; // +2%: dentro do normal
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).level, 0);
    }

    #[test]
    fn sem_lastro_ou_colchao_fino_faz_parar() {
        let mut v = view(10_000 * R, 2_000 * R);
        v.backed = false;
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).reason, REASON_UNBACKED);
        let mut v = view(10_000 * R, 2_000 * R);
        v.baleia_equity_brl = 9_999 * R as i128; // abaixo de 10% de R$ 100 mil
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).reason, REASON_THIN_CUSHION);
        // Sem camada júnior, não há colchão a medir.
        v.has_baleias = false;
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).level, 0);
    }

    #[test]
    fn o_mais_grave_vence() {
        let mut v = view(10_500 * R, 1_000 * R); // queda de 50% em dólar
        v.price = 6 * R; // e salto de 20%
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).level, 2);
        v.backed = false;
        assert_eq!(decide(&snap(10_000 * R, 2_000 * R), &v, 1_300).level, 3);
    }
}
