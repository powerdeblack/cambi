import { useEffect, useId, useState } from "react";
import { pct, rate } from "../format";
import { Period, RateAlert, RatePoint, fetchHistory, summary, withLive } from "../history";
import { QuoteState } from "../useLiveQuote";
import { BellIcon } from "./Icons";

interface Props {
  quote: QuoteState;
  price: number; // cotação em uso no app
  alert: RateAlert | null;
  onAlert: () => void;
}

const W = 300;
const H = 88;
const timeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** Cartão do dólar: cotação ao vivo, variação do período e gráfico que dá para "arrastar o dedo", como em apps de banco. */
export function DollarCard({ quote, price, alert, onAlert }: Props) {
  const [period, setPeriod] = useState<Period>(7);
  const [history, setHistory] = useState<Partial<Record<Period, RatePoint[] | "error">>>({});
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId().replace(/:/g, "");

  useEffect(() => {
    if (history[period]) return;
    let alive = true;
    fetchHistory(period)
      .then((pts) => alive && setHistory((h) => ({ ...h, [period]: pts })))
      .catch(() => alive && setHistory((h) => ({ ...h, [period]: "error" })));
    return () => {
      alive = false;
    };
  }, [period, history]);

  const raw = history[period];
  const live = quote.status === "live" ? { t: Math.floor(quote.checkedAt / 1000), price } : null;
  const points = Array.isArray(raw) ? withLive(raw, live) : null;
  const s = points ? summary(points) : null;

  const geo = (() => {
    if (!points || !s) return null;
    const t0 = points[0].t;
    const span = Math.max(1, points[points.length - 1].t - t0);
    const pad = (s.max - s.min) * 0.12 || 0.01;
    const lo = s.min - pad;
    const hi = s.max + pad;
    const xy = points.map((p) => [((p.t - t0) / span) * W, H - ((p.price - lo) / (hi - lo)) * H] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return { xy, line, area: `${line} L${W},${H} L0,${H} Z` };
  })();

  const sel = hover !== null && points ? points[hover] : null;
  const up = (s?.change ?? 0) >= 0;
  const shown = sel?.price ?? price;

  function scrub(e: React.PointerEvent<HTMLDivElement>) {
    if (!geo) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    geo.xy.forEach(([px], i) => {
      if (Math.abs(px - x) < Math.abs(geo.xy[best][0] - x)) best = i;
    });
    setHover(best);
  }

  return (
    <section className="card dollar-card" aria-label="Cotação do dólar">
      <div className="dollar-head">
        <div>
          <span className="label">{sel ? timeFmt.format(sel.t * 1000) : "Dólar comercial"}</span>
          <strong className="dollar-price">{rate(shown)}</strong>
          {s && !sel && (
            <span className={`var-chip ${up ? "up" : "down"}`}>
              {up ? "▲" : "▼"} {pct(Math.abs(s.pct))} em {period} dias
            </span>
          )}
          {!s && (
            <span className="muted small">
              {quote.status === "live" ? `${quote.quote.source} · ao vivo` : quote.status === "loading" ? "buscando cotação…" : "cotação de referência"}
            </span>
          )}
        </div>
        <button className={`icon-btn bell${alert ? " on" : ""}`} onClick={onAlert} aria-label={alert ? "Ver alerta de cotação" : "Criar alerta de cotação"}>
          <BellIcon />
        </button>
      </div>

      {geo ? (
        <div className="chart" onPointerMove={scrub} onPointerDown={scrub} onPointerLeave={() => setHover(null)} onPointerUp={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Dólar nos últimos ${period} dias: de ${rate(s!.first)} para ${rate(s!.last)}`}>
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--green)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={geo.area} fill={`url(#${gradient})`} />
            <path d={geo.line} fill="none" stroke="var(--green)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {hover !== null && (
              <line x1={geo.xy[hover][0]} x2={geo.xy[hover][0]} y1="0" y2={H} stroke="var(--muted)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          <span
            className="chart-dot"
            style={{ left: `${(geo.xy[hover ?? geo.xy.length - 1][0] / W) * 100}%`, top: `${(geo.xy[hover ?? geo.xy.length - 1][1] / H) * 100}%` }}
            aria-hidden
          />
        </div>
      ) : (
        <div className="chart chart-empty muted small">{raw === "error" ? "Histórico indisponível agora" : "Carregando histórico…"}</div>
      )}

      <div className="dollar-foot">
        <span className="muted small">
          {s ? `mín. ${rate(s.min)} · máx. ${rate(s.max)}` : " "}
        </span>
        <div className="chips tight" role="group" aria-label="Período do gráfico">
          {([7, 30] as Period[]).map((p) => (
            <button key={p} className={`chip${period === p ? " on" : ""}`} onClick={() => setPeriod(p)} aria-pressed={period === p}>
              {p}D
            </button>
          ))}
        </div>
      </div>

      {alert && (
        <button className="alert-chip" onClick={onAlert}>
          <BellIcon /> Aviso quando ficar {alert.dir === "below" ? "abaixo de" : "acima de"} {rate(alert.target)}
        </button>
      )}
    </section>
  );
}
