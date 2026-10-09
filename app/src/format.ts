import type { Side } from "./engine/pool";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });
const pctFmt = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });

export const money = (side: Side, v: number) => (side === "BRL" ? brl : usd).format(v);
export const reais = (v: number) => brl.format(v);
export const pct = (v: number) => pctFmt.format(v);
const pctFine = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
/** Percentual com até 2 casas (alíquotas como 0,38%). */
export const pct2 = (v: number) => pctFine.format(v);

const rateFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 4, maximumFractionDigits: 4 });
/** Cotação de câmbio com 4 casas, como no mercado (R$ 5,4321). */
export const rate = (v: number) => rateFmt.format(v);

/** "agora", "há 40 s", "há 3 min", "há 2 h", "há 2 dias". */
export function ago(unixSeconds: number, now = Date.now()) {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 10) return "agora";
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
}
