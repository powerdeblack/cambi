// Histórico do dólar para o gráfico da tela inicial (só exibição; o pool usa a cotação ao vivo e o oráculo).
import { getJson, isSanePrice } from "./quote";

export interface RatePoint {
  t: number; // unix (segundos)
  price: number; // reais por dólar
}

export type Period = 7 | 30;

/** AwesomeAPI: fechamento diário da cotação comercial, do mais novo para o mais antigo. */
export async function fromAwesomeDaily(days: Period, timeoutMs = 6000): Promise<RatePoint[]> {
  const data = await getJson(`https://economia.awesomeapi.com.br/json/daily/USD-BRL/${days}`, timeoutMs);
  if (!Array.isArray(data)) throw new Error("AwesomeAPI sem histórico");
  return data.map((d) => ({ t: Number(d.timestamp), price: Number(d.bid) }));
}

/** Frankfurter (Banco Central Europeu): uma cotação por dia útil. Reserva. */
export async function fromFrankfurter(days: Period, timeoutMs = 6000, now = Date.now()): Promise<RatePoint[]> {
  const start = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  // Endereço novo direto (o antigo, api.frankfurter.app, redireciona e o redirecionamento não libera CORS).
  const data = await getJson(`https://api.frankfurter.dev/v1/${start}..?base=USD&symbols=BRL`, timeoutMs);
  const rates = data?.rates ?? {};
  return Object.keys(rates).map((day) => ({ t: Date.parse(`${day}T18:00:00Z`) / 1000, price: Number(rates[day]?.BRL) }));
}

/** Coinbase: preço de um dia por chamada (UTC). Última reserva; no período de 30 dias, um ponto a cada 3 dias. */
export async function fromCoinbaseDaily(days: Period, timeoutMs = 6000, now = Date.now()): Promise<RatePoint[]> {
  const step = days > 10 ? 3 : 1;
  const offsets = Array.from({ length: Math.floor(days / step) }, (_, i) => (i + 1) * step);
  const results = await Promise.allSettled(
    offsets.map(async (d) => {
      const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
      const data = await getJson(`https://api.coinbase.com/v2/prices/USD-BRL/spot?date=${day}`, timeoutMs);
      return { t: Date.parse(`${day}T12:00:00Z`) / 1000, price: Number(data?.data?.amount) };
    }),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** Pontos válidos, em ordem de tempo, sem repetir o mesmo instante. */
export function clean(points: RatePoint[]): RatePoint[] {
  const ok = points.filter((p) => Number.isFinite(p.t) && p.t > 0 && isSanePrice(p.price)).sort((a, b) => a.t - b.t);
  return ok.filter((p, i) => i === 0 || p.t !== ok[i - 1].t);
}

export async function fetchHistory(days: Period, sources = [fromAwesomeDaily, fromFrankfurter, fromCoinbaseDaily]): Promise<RatePoint[]> {
  let last: unknown;
  for (const source of sources) {
    try {
      const points = clean(await source(days));
      if (points.length >= 2) return points;
      last = new Error("histórico curto demais");
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("Histórico indisponível");
}

/** Junta a cotação ao vivo no fim da série (o fechamento diário fica para trás durante o dia). */
export function withLive(points: RatePoint[], live: RatePoint | null): RatePoint[] {
  if (!live || !isSanePrice(live.price) || points.length === 0) return points;
  return live.t > points[points.length - 1].t ? [...points, live] : points;
}

/** Variação do período: primeiro e último ponto, mínimo e máximo. */
export function summary(points: RatePoint[]) {
  const first = points[0].price;
  const last = points[points.length - 1].price;
  const prices = points.map((p) => p.price);
  return { first, last, change: last - first, pct: (last - first) / first, min: Math.min(...prices), max: Math.max(...prices) };
}

// ---------- Alerta de cotação ----------

export interface RateAlert {
  dir: "below" | "above"; // avisar quando ficar abaixo de / passar de
  target: number; // reais por dólar
  createdAt: number; // ms
}

export const alertHit = (a: RateAlert, price: number) => (a.dir === "below" ? price <= a.target : price >= a.target);

/** Motivo para não criar o alerta (ele dispararia na hora), ou null se está ok. */
export function alertProblem(a: Pick<RateAlert, "dir" | "target">, current: number): string | null {
  if (!isSanePrice(a.target)) return "Digite uma cotação entre R$ 2 e R$ 15.";
  if (alertHit({ ...a, createdAt: 0 }, current)) {
    return a.dir === "below" ? "O dólar já está abaixo desse valor agora." : "O dólar já está acima desse valor agora.";
  }
  return null;
}

const ALERT_KEY = "cambi-alert-v1";

export function loadAlert(): RateAlert | null {
  try {
    const a = JSON.parse(localStorage.getItem(ALERT_KEY) ?? "null");
    if (a && (a.dir === "below" || a.dir === "above") && isSanePrice(Number(a.target))) {
      return { dir: a.dir, target: Number(a.target), createdAt: Number(a.createdAt) || Date.now() };
    }
  } catch {
    /* armazenamento bloqueado ou dado inválido */
  }
  return null;
}

export function saveAlert(a: RateAlert | null) {
  try {
    if (a) localStorage.setItem(ALERT_KEY, JSON.stringify(a));
    else localStorage.removeItem(ALERT_KEY);
  } catch {
    /* navegação privada: o alerta vale só enquanto a tela estiver aberta */
  }
}

// Histórico guardado por 10 minutos: o cartão do dólar e a tela "Meus dólares" usam a mesma busca.
const cache = new Map<Period, { at: number; points: Promise<RatePoint[]> }>();
export function cachedHistory(days: Period, now = Date.now()): Promise<RatePoint[]> {
  const hit = cache.get(days);
  if (hit && now - hit.at < 600_000) return hit.points;
  const points = fetchHistory(days);
  cache.set(days, { at: now, points });
  points.catch(() => cache.delete(days));
  return points;
}
