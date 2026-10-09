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
  const data = await getJson(`https://api.frankfurter.app/${start}..?from=USD&to=BRL`, timeoutMs);
  const rates = data?.rates ?? {};
  return Object.keys(rates).map((day) => ({ t: Date.parse(`${day}T18:00:00Z`) / 1000, price: Number(rates[day]?.BRL) }));
}

/** Pontos válidos, em ordem de tempo, sem repetir o mesmo instante. */
export function clean(points: RatePoint[]): RatePoint[] {
  const ok = points.filter((p) => Number.isFinite(p.t) && p.t > 0 && isSanePrice(p.price)).sort((a, b) => a.t - b.t);
  return ok.filter((p, i) => i === 0 || p.t !== ok[i - 1].t);
}

export async function fetchHistory(days: Period, sources = [fromAwesomeDaily, fromFrankfurter]): Promise<RatePoint[]> {
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
