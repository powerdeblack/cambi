// Como cada movimentação aparece para a pessoa (tela inicial e extrato).
import type { Wallet } from "./wallet";

export const ACTIVITY_ICON = { swap: "⇄", deposit: "＋", send: "↗", harvest: "✦", withdraw: "↙", faucet: "🎁" } as const;

export function activityTitle(a: Wallet["activity"][number]) {
  if (a.kind === "swap") return `Troca ${a.side === "BRL" ? "real → dólar" : "dólar → real"}`;
  if (a.kind === "deposit") return "Depósito na Rende";
  if (a.kind === "harvest") return "Rendimento recebido";
  if (a.kind === "withdraw") return "Resgate da Rende";
  if (a.kind === "faucet") return "Moedas de teste recebidas";
  if (a.route === "Pix") return "Pix enviado";
  if (a.route === "ACH") return "Envio para conta nos EUA";
  if (a.route === "SWIFT") return "Transferência internacional";
  return "Envio para carteira USDC";
}

export type Activity = Wallet["activity"][number];
export type KindFilter = "all" | "swap" | "send" | "rende";
export type CurrencyFilter = "all" | "BRL" | "USD";

const RENDE_KINDS: Activity["kind"][] = ["deposit", "harvest", "withdraw"];

export function matches(a: Activity, kind: KindFilter, currency: CurrencyFilter) {
  const kindOk = kind === "all" || (kind === "rende" ? RENDE_KINDS.includes(a.kind) : a.kind === kind);
  const other = a.side === "BRL" ? "USD" : "BRL";
  const currencyOk = currency === "all" || a.side === currency || (a.kind === "swap" && other === currency);
  return kindOk && currencyOk;
}

const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" });

/** "Hoje", "Ontem" ou "8 de outubro". */
export function dayLabel(at: number | undefined, now = Date.now()) {
  if (!at) return "Sem data";
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(at) === day(now)) return "Hoje";
  if (day(at) === day(now - 86_400_000)) return "Ontem";
  return dayFmt.format(at);
}

/** Agrupa por dia, mantendo a ordem (mais recente primeiro). */
export function groupByDay(items: Activity[], now = Date.now()) {
  const groups: { label: string; items: Activity[] }[] = [];
  for (const a of items) {
    const label = dayLabel(a.at, now);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(a);
    else groups.push({ label, items: [a] });
  }
  return groups;
}

/** Resumo do mês corrente: quantas movimentações, quanto foi enviado e quanto se economizou contra o banco. */
export function monthSummary(items: Activity[], now = Date.now()) {
  const d = new Date(now);
  const month = items.filter((a) => {
    if (!a.at) return false;
    const x = new Date(a.at);
    return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth();
  });
  const sent = { BRL: 0, USD: 0 };
  let saved = 0;
  for (const a of month) {
    if (a.kind === "send") sent[a.side] += a.amountIn + (a.fee ?? 0);
    if (a.kind === "swap" && a.savedVsBank) saved += a.savedVsBank;
  }
  return { count: month.length, sent, saved };
}
