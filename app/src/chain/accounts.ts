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
  return {
    price, priceUpdatedAt, maxPriceAge, fees, paused, principal, shares, accFeePerShare, lpFeesUnclaimed, platformFees,
    partnerFees, swapCount, volumeBrl, lockupSecs, maxPriceMoveBps, windowStart, windowBase, windowOut,
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
  const reserved = pool.platformFees[s] + pool.partnerFees[s] + pool.lpFeesUnclaimed[s];
  return vaultAmount > reserved ? vaultAmount - reserved : 0n;
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
  const amountOut = sIn === BRL ? (net * PRICE_SCALE) / pool.price : (net * pool.price) / PRICE_SCALE;
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
  if (q.amountOut <= 0n) return "Valor muito pequeno.";
  const availOut = sIn === BRL ? usdAvail : brlAvail;
  if (q.amountOut > availOut) return "Liquidez insuficiente no pool para esta troca.";
  if (q.amountOut > (availOut * pool.fees.maxTradeBps) / BPS) {
    const max = Number((availOut * pool.fees.maxTradeBps) / BPS) / UNIT;
    return `Por segurança, cada troca pode levar até ${Number(pool.fees.maxTradeBps) / 100}% da liquidez (até ${max.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${sIn === BRL ? "dólares" : "reais"}).`;
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
  positions: { side: number; raw: PositionRaw }[];
}

/** Prévia exata da troca, com o tipo de cliente que o programa vai reconhecer (depositante se tem posição na Rende). */
export function previewSwap(s: PreviewInput, sideIn: number, amountIn: bigint, nowSec = Math.floor(Date.now() / 1000)) {
  const kind: Kind = s.positions.some((p) => p.raw.amount > 0n) ? "depositor" : "retail";
  const q = chainQuote(s.pool, sideIn, amountIn, kind, s.avail[0], s.avail[1]);
  const blocker = amountIn > 0n ? swapBlocker(s.pool, sideIn, q, s.avail[0], s.avail[1], nowSec) : null;
  return { kind, q, blocker };
}
