// Motor do pool da cambI.
// Simula, no navegador, a mesma lógica do programa on-chain (programs/cambi_pool):
// troca real <-> dólar a preço de oráculo, taxa dinâmica, e divisão da taxa entre
// depositantes (Rende), provedores de liquidez (Baleia), parceiro regulado e plataforma.

export type Side = "BRL" | "USD";
export type UserKind = "depositor" | "retail" | "b2b";
export type Tranche = "rende" | "baleia";

export const BASE_FEE: Record<UserKind, number> = {
  depositor: 0.005,
  retail: 0.01,
  b2b: 0.004,
};

// Parte do volume que entra ou sai via Pix e paga o parceiro regulado.
export const PIX_FRACTION: Record<UserKind, number> = {
  depositor: 0.5,
  retail: 1.0,
  b2b: 0.2,
};

export const PARTNER_COST = 0.002;
export const PLATFORM_SHARE = 0.25;
export const BALEIA_SHARE_OF_LP = 0.7;
export const DYNAMIC_K = 1.0;
export const DYNAMIC_MIN = 0.7;
export const DYNAMIC_MAX = 1.5;

// Referências de mercado para o comparador (custo total aproximado, sem IOF).
export const BENCHMARKS = [
  { name: "Banco tradicional", rate: 0.055 },
  { name: "Casa de câmbio", rate: 0.038 },
  { name: "Conta global (fintech)", rate: 0.015 },
];

export interface PoolState {
  price: number; // reais por dólar (oráculo)
  liquid: Record<Side, number>; // saldo líquido em cada moeda (unidades da própria moeda)
  deposits: Record<Tranche, Record<Side, number>>;
  fees: {
    rende: Record<Side, number>;
    baleia: Record<Side, number>;
    platform: Record<Side, number>;
    partner: Record<Side, number>;
  };
  swaps: number;
  volumeBRL: number;
}

export interface SwapResult {
  side: Side;
  amountIn: number;
  amountOut: number;
  feeRate: number;
  feeTotal: number;
  toRende: number;
  toBaleia: number;
  toPlatform: number;
  toPartner: number;
  feeCurrency: Side;
  comparison: { name: string; cost: number }[];
  state: PoolState;
}

const zero = (): Record<Side, number> => ({ BRL: 0, USD: 0 });

export function createPool(price: number): PoolState {
  return {
    price,
    liquid: zero(),
    deposits: { rende: zero(), baleia: zero() },
    fees: { rende: zero(), baleia: zero(), platform: zero(), partner: zero() },
    swaps: 0,
    volumeBRL: 0,
  };
}

const clone = (s: PoolState): PoolState => structuredClone(s);

export function toBRL(state: PoolState, side: Side, amount: number): number {
  return side === "BRL" ? amount : amount * state.price;
}

// Desequilíbrio entre -1 e 1: positivo = sobra real, negativo = sobra dólar.
export function imbalance(state: PoolState): number {
  const brl = state.liquid.BRL;
  const usd = state.liquid.USD * state.price;
  const total = brl + usd;
  return total === 0 ? 0 : (brl - usd) / total;
}

export function deposit(
  state: PoolState,
  tranche: Tranche,
  side: Side,
  amount: number,
): PoolState {
  if (amount <= 0) throw new Error("Valor precisa ser maior que zero");
  const s = clone(state);
  s.deposits[tranche][side] += amount;
  s.liquid[side] += amount;
  return s;
}

// Taxa dinâmica: mais barata no sentido que equilibra o pool, mais cara no que desequilibra.
export function dynamicFeeRate(state: PoolState, side: Side, kind: UserKind): number {
  const imb = imbalance(state);
  // Entrar com real piora quando já sobra real (imb > 0); entrar com dólar piora quando sobra dólar.
  const worsens = side === "BRL" ? imb : -imb;
  const mult = Math.min(DYNAMIC_MAX, Math.max(DYNAMIC_MIN, 1 + DYNAMIC_K * worsens));
  return BASE_FEE[kind] * mult;
}

export function quote(state: PoolState, side: Side, amountIn: number, kind: UserKind) {
  const feeRate = dynamicFeeRate(state, side, kind);
  const feeTotal = amountIn * feeRate;
  const net = amountIn - feeTotal;
  const amountOut = side === "BRL" ? net / state.price : net * state.price;
  return { feeRate, feeTotal, amountOut };
}

export function swap(
  state: PoolState,
  side: Side,
  amountIn: number,
  kind: UserKind,
): SwapResult {
  if (amountIn <= 0) throw new Error("Valor precisa ser maior que zero");
  const { feeRate, feeTotal, amountOut } = quote(state, side, amountIn, kind);
  const out: Side = side === "BRL" ? "USD" : "BRL";
  if (amountOut > state.liquid[out]) {
    throw new Error("Liquidez insuficiente no pool para esta troca");
  }

  const toPartner = Math.min(feeTotal, amountIn * PIX_FRACTION[kind] * PARTNER_COST);
  const net = feeTotal - toPartner;
  const toPlatform = net * PLATFORM_SHARE;
  const lp = net - toPlatform;
  const toBaleia = lp * BALEIA_SHARE_OF_LP;
  const toRende = lp - toBaleia;

  const s = clone(state);
  // O valor de entrada (menos a taxa) fica no pool; a taxa é contabilizada à parte.
  s.liquid[side] += amountIn - feeTotal;
  s.liquid[out] -= amountOut;
  s.fees.partner[side] += toPartner;
  s.fees.platform[side] += toPlatform;
  s.fees.baleia[side] += toBaleia;
  s.fees.rende[side] += toRende;
  s.swaps += 1;
  s.volumeBRL += toBRL(state, side, amountIn);

  const inBRL = toBRL(state, side, amountIn);
  const comparison = BENCHMARKS.map((b) => ({ name: b.name, cost: inBRL * b.rate }));

  return {
    side,
    amountIn,
    amountOut,
    feeRate,
    feeTotal,
    toRende,
    toBaleia,
    toPlatform,
    toPartner,
    feeCurrency: side,
    comparison,
    state: s,
  };
}

export function totalValueBRL(state: PoolState): number {
  return state.liquid.BRL + state.liquid.USD * state.price;
}
