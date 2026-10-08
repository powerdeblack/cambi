// Carteira de demonstração do usuário (saldo fictício, só no navegador).
import { PoolState, Side, SwapResult, UserKind, deposit, swap } from "./engine/pool";

export interface Activity {
  id: number;
  kind: "swap" | "deposit" | "send" | "harvest" | "withdraw" | "faucet";
  side: Side; // moeda que saiu da carteira
  amountIn: number;
  amountOut?: number;
  fee?: number;
  savedVsBank?: number; // em reais
  to?: string; // envio: destinatário mascarado (chave Pix, conta ou carteira)
  route?: string; // envio: "Pix", "ACH" ou "USDC"
  at?: number; // quando aconteceu (ms)
  sig?: string; // assinatura da transação na Solana (modo blockchain)
}

/** Destinatário já usado, para repetir o envio em um toque. */
export interface Recipient {
  id: string; // chave única (tipo + valor)
  side: Side;
  route: "pix" | "ach" | "usdc";
  name: string;
  detail: string; // mascarado, para mostrar
  data: Record<string, string>; // dados para preencher de novo
}

export interface Wallet {
  balance: Record<Side, number>;
  rende: Record<Side, number>; // quanto o usuário tem depositado na Rende
  earned: Record<Side, number>; // taxas de câmbio recebidas como depositante
  activity: Activity[];
  recipients: Recipient[];
}

export const INITIAL_WALLET: Wallet = {
  balance: { BRL: 2_000, USD: 0 },
  rende: { BRL: 0, USD: 0 },
  earned: { BRL: 0, USD: 0 },
  activity: [],
  recipients: [],
};

let lastId = 0;
/** Id crescente e único, mesmo depois de recarregar a carteira salva. */
const nextId = () => (lastId = Math.max(lastId + 1, Date.now()));

export const isDepositor = (w: Wallet) => w.rende.BRL > 0 || w.rende.USD > 0;
export const kindFor = (w: Wallet): UserKind => (isDepositor(w) ? "depositor" : "retail");

export function walletSwap(pool: PoolState, w: Wallet, side: Side, amount: number) {
  if (amount > w.balance[side]) throw new Error("Saldo insuficiente na sua carteira");
  const r: SwapResult = swap(pool, side, amount, kindFor(w));
  const out: Side = side === "BRL" ? "USD" : "BRL";
  const feeBRL = side === "BRL" ? r.feeTotal : r.feeTotal * pool.price;
  const bank = r.comparison[0].cost;
  const share = pool.deposits.rende[side] > 0 ? w.rende[side] / pool.deposits.rende[side] : 0;

  const wallet: Wallet = {
    ...w,
    balance: { ...w.balance, [side]: w.balance[side] - amount, [out]: w.balance[out] + r.amountOut },
    // A própria troca também rende para quem é depositante: parte da taxa volta para ele.
    earned: { ...w.earned, [side]: w.earned[side] + r.toRende * share },
    activity: [
      { id: nextId(), kind: "swap", side, amountIn: amount, amountOut: r.amountOut, fee: r.feeTotal, savedVsBank: bank - feeBRL, at: Date.now() },
      ...w.activity,
    ],
  };
  return { pool: r.state, wallet, result: r };
}

export function walletDeposit(pool: PoolState, w: Wallet, side: Side, amount: number) {
  if (amount > w.balance[side]) throw new Error("Saldo insuficiente na sua carteira");
  const p = deposit(pool, "rende", side, amount);
  const wallet: Wallet = {
    ...w,
    balance: { ...w.balance, [side]: w.balance[side] - amount },
    rende: { ...w.rende, [side]: w.rende[side] + amount },
    activity: [{ id: nextId(), kind: "deposit", side, amountIn: amount, at: Date.now() }, ...w.activity],
  };
  return { pool: p, wallet };
}

// Simula o movimento de outros usuários do pool, para o depositante ver o rendimento chegando.
export function simulateMarket(pool: PoolState, w: Wallet, trades = 20) {
  let p = pool;
  let earned = { ...w.earned };
  for (let i = 0; i < trades; i++) {
    const side: Side = i % 2 === 0 ? "BRL" : "USD";
    const amount = side === "BRL" ? 3_000 + (i % 5) * 1_500 : 600 + (i % 4) * 250;
    try {
      const r = swap(p, side, amount, i % 3 === 0 ? "b2b" : "retail");
      const share = p.deposits.rende[side] > 0 ? w.rende[side] / p.deposits.rende[side] : 0;
      earned = { ...earned, [side]: earned[side] + r.toRende * share };
      p = r.state;
    } catch {
      // sem liquidez para essa troca: ignora
    }
  }
  return { pool: p, wallet: { ...w, earned } };
}

/** Envio para fora da cambI (Pix ou conta em dólar). Debita valor + tarifa e guarda o destinatário. */
export function walletSend(w: Wallet, side: Side, amount: number, fee: number, recipient: Recipient) {
  if (!(amount > 0)) throw new Error("Informe um valor");
  if (amount + fee > w.balance[side] + 1e-9) throw new Error("Saldo insuficiente na sua carteira");
  const route = recipient.route === "pix" ? "Pix" : recipient.route === "ach" ? "ACH" : "USDC";
  const activity: Activity = {
    id: nextId(),
    kind: "send",
    side,
    amountIn: amount,
    fee,
    to: `${recipient.name} · ${recipient.detail}`,
    route,
    at: Date.now(),
  };
  return {
    ...w,
    balance: { ...w.balance, [side]: w.balance[side] - amount - fee },
    activity: [activity, ...w.activity],
    recipients: [recipient, ...w.recipients.filter((r) => r.id !== recipient.id)].slice(0, 6),
  };
}

/** Guarda o destinatário nos recentes sem mexer no saldo (modo blockchain: o saldo vem da Solana). */
export function rememberRecipient(w: Wallet, recipient: Recipient): Wallet {
  return { ...w, recipients: [recipient, ...w.recipients.filter((r) => r.id !== recipient.id)].slice(0, 6) };
}
