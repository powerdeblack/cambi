import type { Side } from "./engine/pool";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });
const pctFmt = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });

export const money = (side: Side, v: number) => (side === "BRL" ? brl : usd).format(v);
export const reais = (v: number) => brl.format(v);
export const pct = (v: number) => pctFmt.format(v);
