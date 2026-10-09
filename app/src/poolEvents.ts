// Histórico real do pool: lê as transações do pool na Solana e decodifica os eventos que o programa emite
// (SwapEvent e DepositEvent, em "Program data:" nos logs). Sem dependências pesadas; cache por assinatura.
import { base64ToBytes, rpc } from "./onchain";

const UNIT = 1_000_000;
const DISC = {
  swap: [64, 198, 205, 232, 38, 8, 113, 226],
  deposit: [120, 248, 61, 83, 31, 142, 107, 144],
} as const;

export interface SwapEvt {
  kind: "swap";
  sig: string;
  at: number; // unix (s)
  user: string;
  sideIn: 0 | 1; // 0 = real entrou (comprou dólar), 1 = dólar entrou
  amountIn: number;
  amountOut: number;
  fee: number; // na moeda de entrada
  toRende: number;
  toBaleia: number;
  price: number; // reais por dólar
}

export interface DepositEvt {
  kind: "deposit";
  sig: string;
  at: number;
  user: string;
  tranche: number;
  side: number;
  amount: number;
}

export type PoolEvt = SwapEvt | DepositEvt;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Chave pública (32 bytes) em base58. */
export function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

const same = (a: Uint8Array, d: readonly number[]) => d.every((x, i) => a[i] === x);

/** Decodifica um evento do programa (bytes de "Program data:"). Null se não for troca nem depósito. */
export function decodeEvent(data: Uint8Array, sig: string, at: number): PoolEvt | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => Number(v.getBigUint64(o, true)) / UNIT;
  if (data.length >= 8 + 32 + 1 + 8 * 8 && same(data, DISC.swap)) {
    const o = 8 + 32 + 1;
    return {
      kind: "swap",
      sig,
      at,
      user: toBase58(data.slice(8, 40)),
      sideIn: data[40] === 1 ? 1 : 0,
      amountIn: u64(o),
      amountOut: u64(o + 8),
      fee: u64(o + 16),
      toRende: u64(o + 24),
      toBaleia: u64(o + 32),
      price: u64(o + 56),
    };
  }
  if (data.length >= 8 + 32 + 2 + 8 && same(data, DISC.deposit)) {
    return { kind: "deposit", sig, at, user: toBase58(data.slice(8, 40)), tranche: data[40], side: data[41], amount: u64(42) };
  }
  return null;
}

/** Eventos de uma transação, a partir dos logs. */
export function eventsFromLogs(logs: string[], sig: string, at: number): PoolEvt[] {
  const out: PoolEvt[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    try {
      const e = decodeEvent(base64ToBytes(m[1]), sig, at);
      if (e) out.push(e);
    } catch {
      /* outro formato de dado: ignora */
    }
  }
  return out;
}

const CACHE = "cambi-pool-events-v1";
type Cache = Record<string, PoolEvt[]>;
const loadCache = (): Cache => {
  try {
    return JSON.parse(localStorage.getItem(CACHE) ?? "{}");
  } catch {
    return {};
  }
};
const saveCache = (c: Cache) => {
  try {
    const keys = Object.keys(c);
    // Guarda no máximo as 300 transações mais recentes vistas.
    const trimmed = keys.length > 300 ? Object.fromEntries(keys.slice(-300).map((k) => [k, c[k]])) : c;
    localStorage.setItem(CACHE, JSON.stringify(trimmed));
  } catch {
    /* sem armazenamento */
  }
};

/**
 * Últimas transações do pool (até `limit`), do mais antigo para o mais novo. Transações já lidas vêm do cache
 * (são imutáveis); as novas são buscadas aos poucos para não estourar o limite da RPC pública.
 */
export async function fetchPoolEvents(rpcUrl: string, pool: string, limit = 60): Promise<PoolEvt[]> {
  const sigs = await rpc<{ signature: string; blockTime: number | null; err: unknown }[]>(rpcUrl, "getSignaturesForAddress", [
    pool,
    { limit, commitment: "confirmed" },
  ]);
  const ok = sigs.filter((s) => !s.err);
  const cache = loadCache();
  const missing = ok.filter((s) => !cache[s.signature]);
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(
      missing.slice(i, i + 3).map(async (s) => {
        try {
          const tx = await rpc<{ blockTime: number | null; meta: { logMessages: string[] | null } | null } | null>(rpcUrl, "getTransaction", [
            s.signature,
            { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
          ]);
          if (tx) cache[s.signature] = eventsFromLogs(tx.meta?.logMessages ?? [], s.signature, tx.blockTime ?? s.blockTime ?? 0);
        } catch {
          /* tenta de novo na próxima leitura */
        }
      }),
    );
  }
  saveCache(cache);
  return ok
    .flatMap((s) => cache[s.signature] ?? [])
    .sort((a, b) => a.at - b.at);
}

/** Total pago aos donos do pool (Rende + Baleia) nos eventos, em reais. */
export const ownersEarnedBRL = (evts: PoolEvt[]) =>
  evts.reduce((s, e) => (e.kind === "swap" ? s + (e.toRende + e.toBaleia) * (e.sideIn === 1 ? e.price : 1) : s), 0);

/**
 * Curva do rendimento de uma pessoa: um ponto por troca real depois do primeiro depósito, distribuindo o total exato
 * (lido do programa) na proporção da parte da Rende de cada troca. O último ponto é o valor exato.
 */
export function earningsCurve(evts: PoolEvt[], since: number, exactTotalBRL: number) {
  const swaps = evts.filter((e): e is SwapEvt => e.kind === "swap" && e.at >= since);
  const weight = (e: SwapEvt) => e.toRende * (e.sideIn === 1 ? e.price : 1);
  const totalWeight = swaps.reduce((s, e) => s + weight(e), 0);
  let acc = 0;
  const points = [{ at: since, value: 0, sig: "" }];
  for (const e of swaps) {
    acc += totalWeight > 0 ? (weight(e) / totalWeight) * exactTotalBRL : 0;
    points.push({ at: e.at, value: acc, sig: e.sig });
  }
  if (swaps.length === 0) points.push({ at: Math.floor(Date.now() / 1000), value: exactTotalBRL, sig: "" });
  return points;
}

/** Curva acumulada do que o pool pagou aos donos (Rende + Baleia), uma troca real por ponto. */
export function ownersCurve(evts: PoolEvt[]) {
  let acc = 0;
  return evts
    .filter((e): e is SwapEvt => e.kind === "swap")
    .map((e) => {
      acc += (e.toRende + e.toBaleia) * (e.sideIn === 1 ? e.price : 1);
      return { at: e.at, value: acc, sig: e.sig };
    });
}

/**
 * Coloca pontos marcados (ex.: depósitos, compras) numa curva acumulada. Cada marca vira um ponto no instante em que
 * aconteceu, com o valor acumulado até ali, para o losango ficar exatamente sobre a linha.
 */
export function addMarks<P extends { at: number; value: number }>(points: P[], marks: { at: number; label: string }[]) {
  const out: { at: number; value: number; mark?: string }[] = points.map((p) => ({ at: p.at, value: p.value }));
  for (const m of marks) {
    const same = out.find((p) => p.at === m.at && !p.mark);
    if (same) {
      same.mark = m.label;
      continue;
    }
    const before = [...out].reverse().find((p) => p.at <= m.at);
    if (!before && out.length) continue; // antes do começo da curva
    out.push({ at: m.at, value: before?.value ?? 0, mark: m.label });
    out.sort((a, b) => a.at - b.at);
  }
  return {
    points: out,
    markers: out.flatMap((p, i) => (p.mark ? [{ i, label: p.mark }] : [])),
  };
}
