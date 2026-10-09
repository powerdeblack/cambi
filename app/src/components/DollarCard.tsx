import { useEffect, useState } from "react";
import { pct, rate } from "../format";
import { Period, RateAlert, RatePoint, cachedHistory, summary, withLive } from "../history";
import { QuoteState } from "../useLiveQuote";
import { BellIcon } from "./Icons";
import { RateChart } from "./RateChart";

interface Props {
  quote: QuoteState;
  price: number; // cotação em uso no app
  alert: RateAlert | null;
  onAlert: () => void;
}

const timeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** Histórico do período, com a cotação ao vivo no fim. "error" se nenhuma fonte respondeu. */
export function useHistory(period: Period, quote: QuoteState, price: number) {
  const [history, setHistory] = useState<Partial<Record<Period, RatePoint[] | "error">>>({});
  useEffect(() => {
    if (history[period]) return;
    let alive = true;
    cachedHistory(period)
      .then((pts) => alive && setHistory((h) => ({ ...h, [period]: pts })))
      .catch(() => alive && setHistory((h) => ({ ...h, [period]: "error" })));
    return () => {
      alive = false;
    };
  }, [period, history]);
  const raw = history[period];
  const live = quote.status === "live" ? { t: Math.floor(quote.checkedAt / 1000), price } : null;
  return { raw, points: Array.isArray(raw) ? withLive(raw, live) : null };
}

export function PeriodChips({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div className="chips tight" role="group" aria-label="Período do gráfico">
      {([7, 30] as Period[]).map((p) => (
        <button key={p} className={`chip${period === p ? " on" : ""}`} onClick={() => onChange(p)} aria-pressed={period === p}>
          {p}D
        </button>
      ))}
    </div>
  );
}

/** Cartão do dólar: cotação ao vivo, variação do período e gráfico que dá para "arrastar o dedo", como em apps de banco. */
export function DollarCard({ quote, price, alert, onAlert }: Props) {
  const [period, setPeriod] = useState<Period>(7);
  const [hover, setHover] = useState<number | null>(null);
  const { raw, points } = useHistory(period, quote, price);
  const s = points ? summary(points) : null;
  const sel = hover !== null && points ? points[hover] : null;
  const up = (s?.change ?? 0) >= 0;

  return (
    <section className="card dollar-card" aria-label="Cotação do dólar">
      <div className="dollar-head">
        <div>
          <span className="label">{sel ? timeFmt.format(sel.t * 1000) : "Dólar comercial"}</span>
          <strong className="dollar-price">{rate(sel?.price ?? price)}</strong>
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

      {points && s ? (
        <RateChart points={points} hover={hover} onHover={setHover} label={`Dólar nos últimos ${period} dias: de ${rate(s.first)} para ${rate(s.last)}`} />
      ) : (
        <div className="chart chart-empty muted small">{raw === "error" ? "Histórico indisponível agora" : "Carregando histórico…"}</div>
      )}

      <div className="dollar-foot">
        <span className="muted small">{s ? `mín. ${rate(s.min)} · máx. ${rate(s.max)}` : " "}</span>
        <PeriodChips period={period} onChange={setPeriod} />
      </div>

      {alert && (
        <button className="alert-chip" onClick={onAlert}>
          <BellIcon /> Aviso quando ficar {alert.dir === "below" ? "abaixo de" : "acima de"} {rate(alert.target)}
        </button>
      )}
    </section>
  );
}
