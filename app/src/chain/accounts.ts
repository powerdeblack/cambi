// Contas do programa cambi_pool decodificadas com valores exatos (bigint), e a mesma matemática do programa
// (programs/cambi_pool/src/lib.rs: quote, available, pending_fees). Assim a prévia no app bate com o que a
// blockchain entrega, centavo por centavo.

export const PRICE_SCALE = 1_000_000n;
export const ACC_SCALE = 1_000_000_000_000n;
export const BPS = 10_000n;
export const UNIT = 1_000_000; // 6 casas decimais dos tokens
export const BRL = 0;
export const USD = 1;
export const RENDE = 0;
export const BALEIA = 1;

export type Kind = "depositor" | "retail" | "b2b";

export interface FeeConfig {
  depositorBps: bigint;
  retailBps: bigint;
  b2bBps: bigint;
  depositorPixBps: bigint;
  retailPixBps: bigint;
  b2bPixBps: bigint;
  partnerCostBps: bigint;
  platformShareBps: bigint;
  baleiaShareBps: bigint;
  dynamicMinBps: bigint;
  dynamicMaxBps: bigint;
  maxTradeBps: bigint;
}

export interface PoolRaw {
  price: bigint;
  priceUpdatedAt: number;
  maxPriceAge: number;
  fees: FeeConfig;
  paused: boolean;
  principal: bigint[]; // [rende_brl, rende_usd, baleia_brl, baleia_usd]
  shares: bigint[]; // [rende, baleia]
  accFeePerShare: bigint[]; // [rende_brl, rende_usd, baleia_brl, baleia_usd]
  lpFeesUnclaimed: bigint[];
  platformFees: bigint[];
  partnerFees: bigint[];
  swapCount: bigint;
  volumeBrl: bigint;
  lockupSecs: number;
  maxPriceMoveBps: number;
  windowStart: number;
  windowBase: bigint[];
  windowOut: bigint[];
  /** Regras de segurança do programa v2 (ausentes no programa v1). */
  safety?: PoolSafety;
}

export interface PoolSafety {
  requireKyc: boolean;
  levelLimitBrl: bigint[]; // teto por operação, por nível (0 = sem teto)
  breakerWindowSecs: number;
  breakerBps: bigint;
  breakerStart: number;
  breakerBase: bigint[];
  breakerOut: bigint[];
  instantWithdrawBps: bigint;
  withdrawNoticeSecs: number;
  queued: bigint[];
  reserveMaxAge: number;
  levelDailyBrl: bigint[];
  rebalanceKBps: bigint; // desconto para quem reequilibra (0 = desligado)
  /** Programa v2.6: travas por tempo do guardião e reserva da Rende (ausentes antes do v2.6). */
  restUntil: number;
  breatheUntil: number;
  breatheSide: number;
  rendeReserveBps: bigint;
}

export interface PositionRaw {
  owner: Uint8Array;
  pool: Uint8Array;
  tranche: number;
  side: number;
  amount: bigint;
  shares: bigint;
  rewardDebt: bigint[];
  lastDepositAt: number;
}

class Reader {
  private o: number;
  private v: DataView;
  get offset() {
    return this.o;
  }
  constructor(private data: Uint8Array, offset = 8) {
    this.v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.o = offset;
  }
  skip(n: number) {
    this.o += n;
  }
  bytes(n: number) {
    const b = this.data.slice(this.o, this.o + n);
    this.o += n;
    return b;
  }
  u8() {
    return this.data[this.o++];
  }
  u16() {
    const x = this.v.getUint16(this.o, true);
    this.o += 2;
    return BigInt(x);
  }
  u64() {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64() {
    const x = this.v.getBigInt64(this.o, true);
    this.o += 8;
    return Number(x);
  }
  u128() {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
}

export function decodePoolRaw(data: Uint8Array): PoolRaw {
  const r = new Reader(data);
  r.skip(32 * 6); // admin, oracle, 2 mints, 2 cofres
  const price = r.u64();
  const priceUpdatedAt = r.i64();
  const maxPriceAge = r.i64();
  const fees: FeeConfig = {
    depositorBps: r.u16(),
    retailBps: r.u16(),
    b2bBps: r.u16(),
    depositorPixBps: r.u16(),
    retailPixBps: r.u16(),
    b2bPixBps: r.u16(),
    partnerCostBps: r.u16(),
    platformShareBps: r.u16(),
    baleiaShareBps: r.u16(),
    dynamicMinBps: r.u16(),
    dynamicMaxBps: r.u16(),
    maxTradeBps: r.u16(),
  };
  const paused = r.u8() === 1;
  const principal = [r.u64(), r.u64(), r.u64(), r.u64()];
  const shares = [r.u128(), r.u128()];
  const accFeePerShare = [r.u128(), r.u128(), r.u128(), r.u128()];
  const lpFeesUnclaimed = [r.u64(), r.u64()];
  const platformFees = [r.u64(), r.u64()];
  const partnerFees = [r.u64(), r.u64()];
  const swapCount = r.u64();
  const volumeBrl = r.u64();
  r.u8(); // bump
  r.skip(32); // pending_admin
  const lockupSecs = r.i64();
  const maxPriceMoveBps = Number(r.u16());
  const windowStart = r.i64();
  const windowBase = [r.u64(), r.u64()];
  const windowOut = [r.u64(), r.u64()];
  let safety: PoolSafety | undefined;
  // Programa v2: campos novos no fim da conta.
  if (data.length >= r.offset + 16 + 32 * 2 + 1 + 24 + 8 + 2 + 8 + 32 + 2 + 8 + 16 + 32 + 8) {
    r.skip(16); // faucet_window_start, faucet_window_minted
    r.skip(64); // guardian, kyc_issuer
    const requireKyc = r.u8() === 1;
    const levelLimitBrl = [r.u64(), r.u64(), r.u64()];
    const breakerWindowSecs = r.i64();
    const breakerBps = r.u16();
    const breakerStart = r.i64();
    const breakerBase = [r.u64(), r.u64()];
    const breakerOut = [r.u64(), r.u64()];
    const instantWithdrawBps = r.u16();
    const withdrawNoticeSecs = r.i64();
    const queued = [r.u64(), r.u64()];
    r.skip(32); // reserve_attester
    const reserveMaxAge = r.i64();
    const more = data.length >= r.offset + 24 + 2;
    const levelDailyBrl = more ? [r.u64(), r.u64(), r.u64()] : [0n, 0n, 0n];
    const rebalanceKBps = more ? r.u16() : 0n;
    // v2.6: rest_until, breathe_until, breathe_side, rest_day_start, rest_day_used, rende_reserve_bps.
    const v26 = more && data.length >= r.offset + 8 + 8 + 1 + 16 + 2;
    const restUntil = v26 ? r.i64() : 0;
    const breatheUntil = v26 ? r.i64() : 0;
    const breatheSide = v26 ? r.u8() : 0;
    if (v26) r.skip(16); // rest_day_start, rest_day_used
    const rendeReserveBps = v26 ? r.u16() : 0n;
    safety = {
      requireKyc, levelLimitBrl, breakerWindowSecs, breakerBps, breakerStart, breakerBase, breakerOut, instantWithdrawBps,
      withdrawNoticeSecs, queued, reserveMaxAge, levelDailyBrl, rebalanceKBps, restUntil, breatheUntil, breatheSide, rendeReserveBps,
    };
  }
  return {
    price, priceUpdatedAt, maxPriceAge, fees, paused, principal, shares, accFeePerShare, lpFeesUnclaimed, platformFees,
    partnerFees, swapCount, volumeBrl, lockupSecs, maxPriceMoveBps, windowStart, windowBase, windowOut, safety,
  };
}

export function decodePositionRaw(data: Uint8Array): PositionRaw {
  const r = new Reader(data);
  const owner = r.bytes(32);
  const pool = r.bytes(32);
  const tranche = r.u8();
  const side = r.u8();
  const amount = r.u64();
  const shares = r.u128();
  const rewardDebt = [r.u128(), r.u128()];
  r.u8(); // bump
  const lastDepositAt = r.i64();
  return { owner, pool, tranche, side, amount, shares, rewardDebt, lastDepositAt };
}

/** Liquidez livre do cofre: saldo menos as taxas reservadas (igual a `available` no programa). */
export function available(pool: PoolRaw, vaultAmount: bigint, s: number): bigint {
  const reserved = pool.platformFees[s] + pool.partnerFees[s] + pool.lpFeesUnclaimed[s] + (pool.safety?.queued[s] ?? 0n);
  return vaultAmount > reserved ? vaultAmount - reserved : 0n;
}

/** Liquidez das trocas (v2.6, igual a `swap_available`): a livre menos a reserva da Rende, que as trocas não tocam. */
export function swapAvailable(pool: PoolRaw, vaultAmount: bigint, s: number): bigint {
  const free = available(pool, vaultAmount, s);
  const reserve = (pool.principal[RENDE * 2 + s] * (pool.safety?.rendeReserveBps ?? 0n)) / BPS;
  return free > reserve ? free - reserve : 0n;
}

export interface ChainQuote {
  fee: bigint;
  feeBps: bigint;
  amountOut: bigint;
  toPartner: bigint;
  toPlatform: bigint;
  toBaleia: bigint;
  toRende: bigint;
}

const clamp = (x: bigint, lo: bigint, hi: bigint) => (x < lo ? lo : x > hi ? hi : x);

/** Porta fiel de `quote` do programa (divisões inteiras truncadas, como em Rust). */
export function chainQuote(pool: PoolRaw, sIn: number, amountIn: bigint, kind: Kind, brlAvail: bigint, usdAvail: bigint): ChainQuote {
  const f = pool.fees;
  const [baseBps, pixBps] =
    kind === "depositor" ? [f.depositorBps, f.depositorPixBps] : kind === "retail" ? [f.retailBps, f.retailPixBps] : [f.b2bBps, f.b2bPixBps];
  const usdInBrl = (usdAvail * pool.price) / PRICE_SCALE;
  const total = brlAvail + usdInBrl;
  // Em Rust a divisão de i128 trunca em direção a zero; BigInt também.
  const imb = total === 0n ? 0n : ((brlAvail - usdInBrl) * BPS) / total;
  const worsens = sIn === BRL ? imb : -imb;
  const mult = clamp(BPS + worsens, f.dynamicMinBps, f.dynamicMaxBps);
  const feeBps = (baseBps * mult) / BPS;
  const fee = (amountIn * feeBps) / BPS;
  const net = amountIn - fee;
  let amountOut = sIn === BRL ? (net * PRICE_SCALE) / pool.price : (net * pool.price) / PRICE_SCALE;
  // Desconto para quem reequilibra (programa v2): igual ao `quote` em Rust, divisões inteiras truncadas.
  const k = pool.safety?.rebalanceKBps ?? 0n;
  if (k > 0n && worsens < 0n && total > 0n) {
    const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
    const [brl2, usd2] =
      sIn === BRL ? [brlAvail + net, sub(usdInBrl, (amountOut * pool.price) / PRICE_SCALE)] : [sub(brlAvail, amountOut), usdInBrl + net];
    const total2 = brl2 + usd2;
    const imb2 = total2 === 0n ? 0n : ((brl2 - usd2) * BPS) / total2;
    const sign = (x: bigint) => (x > 0n ? 1 : x < 0n ? -1 : 0);
    if (sign(imb2) === sign(imb)) {
      const abs = imb2 < 0n ? -imb2 : imb2;
      let bonus = (k * abs) / BPS;
      if (bonus > feeBps + baseBps) bonus = feeBps + baseBps;
      amountOut = (amountOut * (BPS + bonus)) / BPS;
    }
  }
  let toPartner = (amountIn * pixBps * f.partnerCostBps) / BPS / BPS;
  if (toPartner > fee) toPartner = fee;
  const afterPartner = fee - toPartner;
  const toPlatform = (afterPartner * f.platformShareBps) / BPS;
  const lp = afterPartner - toPlatform;
  const toBaleia = (lp * f.baleiaShareBps) / BPS;
  const toRende = lp - toBaleia;
  return { fee, feeBps, amountOut, toPartner, toPlatform, toBaleia, toRende };
}

/** Por que o programa recusaria a troca (mesma ordem das checagens), ou null. */
export function swapBlocker(pool: PoolRaw, sIn: number, q: ChainQuote, brlAvail: bigint, usdAvail: bigint, nowSec: number): string | null {
  if (pool.paused) return "O pool está pausado para trocas no momento.";
  if (nowSec - pool.priceUpdatedAt > pool.maxPriceAge) return "Cotação do pool desatualizada. Tente em alguns minutos.";
  const g = pool.safety;
  if (g && nowSec < g.restUntil) return "Guardião em descanso: trocas e depósitos voltam sozinhos em poucos minutos; saques seguem liberados.";
  if (g && nowSec < g.breatheUntil && g.breatheSide === 1 - sIn)
    return "Guardião pediu respiro: esta moeda está saindo rápido demais. A troca no sentido contrário segue liberada.";
  if (q.amountOut <= 0n) return "Valor muito pequeno.";
  const availOut = sIn === BRL ? usdAvail : brlAvail;
  if (q.amountOut > availOut) return "Liquidez insuficiente no pool para esta troca.";
  if (q.amountOut > (availOut * pool.fees.maxTradeBps) / BPS) {
    const max = Number((availOut * pool.fees.maxTradeBps) / BPS) / UNIT;
    return `Por segurança, cada troca pode levar até ${Number(pool.fees.maxTradeBps) / 100}% da liquidez (até ${max.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${sIn === BRL ? "dólares" : "reais"}).`;
  }
  const sf = pool.safety;
  if (sf) {
    // Disjuntor: mesma conta do programa (a janela recomeça sozinha depois do prazo).
    // Janela deslizante, igual a `breaker_roll`: a saída escoa ao longo da janela; a base cai na hora e sobe devagar.
    const sOut = 1 - sIn;
    const w = BigInt(Math.max(1, sf.breakerWindowSecs));
    const e = BigInt(Math.min(Math.max(0, nowSec - sf.breakerStart), Math.max(1, sf.breakerWindowSecs)));
    const out = (sf.breakerOut[sOut] * (w - e)) / w;
    const current = availOut + out;
    const base0 = sf.breakerBase[sOut];
    const base = current >= base0 ? base0 + ((current - base0) * e) / w : current;
    if (out + q.amountOut > (base * sf.breakerBps) / BPS) return "Disjuntor de segurança: o pool atingiu o teto de saída desta hora. Tente mais tarde ou um valor menor.";
  }
  return null;
}

/** Taxas a receber de uma posição (igual a `pending_fees`). */
export function pendingFees(pool: PoolRaw, pos: PositionRaw): [bigint, bigint] {
  const out: bigint[] = [];
  for (let s = 0; s < 2; s++) {
    const accrued = (pos.shares * pool.accFeePerShare[pos.tranche * 2 + s]) / ACC_SCALE;
    out.push(accrued > pos.rewardDebt[s] ? accrued - pos.rewardDebt[s] : 0n);
  }
  return [out[0], out[1]];
}

export const toUnits = (v: number) => BigInt(Math.round(v * UNIT));
export const fromUnits = (v: bigint) => Number(v) / UNIT;

/** O que a prévia da troca precisa do estado da conta (sem depender do web3.js). */
export interface PreviewInput {
  pool: PoolRaw;
  avail: [bigint, bigint];
  /** Liquidez das trocas (v2.6: sem a reserva da Rende). Sem ela, vale `avail`. */
  swapAvail?: [bigint, bigint];
  positions: { side: number; raw: PositionRaw }[];
}

/**
 * Posição que dá o desconto de depositante, com a mesma regra do programa: valor em reais de pelo menos R$ 10 (v1)
 * ou R$ 1.000 (v2).
 */
export function discountPosition(s: PreviewInput) {
  const min = (s.pool.safety ? 1_000n : 10n) * 1_000_000n;
  return s.positions.find((p) => (p.side === BRL ? p.raw.amount : (p.raw.amount * s.pool.price) / PRICE_SCALE) >= min);
}

/** Prévia exata da troca, com o tipo de cliente que o programa vai reconhecer (depositante se tem posição na Rende). */
export function previewSwap(s: PreviewInput, sideIn: number, amountIn: bigint, nowSec = Math.floor(Date.now() / 1000)) {
  const kind: Kind = discountPosition(s) ? "depositor" : "retail";
  const [brl, usd] = s.swapAvail ?? s.avail;
  const q = chainQuote(s.pool, sideIn, amountIn, kind, brl, usd);
  const blocker = amountIn > 0n ? swapBlocker(s.pool, sideIn, q, brl, usd, nowSec) : null;
  return { kind, q, blocker };
}
