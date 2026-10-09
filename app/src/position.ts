// "Meus dólares": preço médio de compra e resultado da posição em dólar, com e sem os ganhos do pool.
import type { Activity, Wallet } from "./wallet";

export interface DollarPosition {
  /** Dólares comprados que ainda estão com a pessoa (pelo histórico de trocas). */
  usdBought: number;
  /** Quanto custaram, em reais, com a taxa incluída. */
  costBRL: number;
  /** Preço médio pago por dólar (null se nunca comprou). */
  avgPrice: number | null;
}

/**
 * Custo médio, como numa corretora: cada compra soma ao custo; cada venda ou envio de dólar tira
 * a mesma proporção do custo (o preço médio dos dólares que ficaram não muda).
 */
export function dollarPosition(activity: Activity[]): DollarPosition {
  let usd = 0;
  let cost = 0;
  const oldestFirst = [...activity].sort((a, b) => (a.at ?? a.id) - (b.at ?? b.id));
  for (const a of oldestFirst) {
    const bought = a.kind === "swap" && a.side === "BRL" && (a.amountOut ?? 0) > 0;
    const leaving = (a.kind === "swap" || a.kind === "send") && a.side === "USD";
    if (bought) {
      usd += a.amountOut!;
      cost += a.amountIn;
    } else if (leaving && usd > 0) {
      const out = Math.min(usd, a.amountIn + (a.kind === "send" ? a.fee ?? 0 : 0));
      cost -= cost * (out / usd);
      usd -= out;
    }
  }
  if (usd < 1e-6) return { usdBought: 0, costBRL: 0, avgPrice: null };
  return { usdBought: usd, costBRL: cost, avgPrice: cost / usd };
}

export interface DollarResult {
  avgPrice: number;
  usdOwned: number; // dólares na carteira e na Rende
  fx: number; // resultado do câmbio em reais: (cotação − preço médio) × dólares
  fxPct: number;
  pool: number; // ganhos com as taxas do pool, em reais
  total: number;
}

/** Resultado se a pessoa vendesse tudo agora, na cotação atual. Null se ela não tem dólares comprados. */
export function dollarResult(w: Wallet, price: number): DollarResult | null {
  const pos = dollarPosition(w.activity);
  const usdOwned = w.balance.USD + w.rende.USD;
  if (pos.avgPrice === null || usdOwned <= 0) return null;
  const fx = usdOwned * (price - pos.avgPrice);
  const harvested = w.activity.filter((a) => a.kind === "harvest").reduce((s, a) => s + a.amountIn, 0);
  const pool = w.earned.BRL + w.earned.USD * price + harvested;
  return { avgPrice: pos.avgPrice, usdOwned, fx, fxPct: price / pos.avgPrice - 1, pool, total: fx + pool };
}
