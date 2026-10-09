import { useId } from "react";
import { rate } from "../format";
import { RatePoint } from "../history";

interface Props {
  points: RatePoint[];
  hover: number | null;
  onHover: (i: number | null) => void;
  /** Linha de referência (ex.: seu preço médio). */
  refPrice?: number;
  refLabel?: string;
  label: string; // descrição para leitor de tela
  /** Suas compras: data e preço pago, marcados no gráfico. */
  marks?: { t: number; price: number }[];
}

const W = 300;
const H = 88;

/** Gráfico de linha da cotação, em que dá para arrastar o dedo; opcionalmente com uma linha de referência. */
export function RateChart({ points, hover, onHover, refPrice, refLabel, label, marks = [] }: Props) {
  const gradient = useId().replace(/:/g, "");
  const t1 = points[points.length - 1].t;
  const inRange = marks.filter((m) => m.t >= points[0].t && m.t <= t1 + 3600);
  const prices = points.map((p) => p.price).concat(refPrice ? [refPrice] : [], inRange.map((m) => m.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = (max - min) * 0.12 || 0.01;
  const lo = min - pad;
  const hi = max + pad;
  const t0 = points[0].t;
  const span = Math.max(1, points[points.length - 1].t - t0);
  const y = (price: number) => H - ((price - lo) / (hi - lo)) * H;
  const xy = points.map((p) => [((p.t - t0) / span) * W, y(p.price)] as const);
  const line = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const dot = xy[hover ?? xy.length - 1];

  function scrub(e: React.PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    xy.forEach(([px], i) => {
      if (Math.abs(px - x) < Math.abs(xy[best][0] - x)) best = i;
    });
    onHover(best);
  }

  return (
    <div className="chart" onPointerMove={scrub} onPointerDown={scrub} onPointerLeave={() => onHover(null)} onPointerUp={() => onHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gradient})`} />
        {refPrice !== undefined && (
          <line x1="0" x2={W} y1={y(refPrice)} y2={y(refPrice)} stroke="var(--whale)" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        )}
        <path d={line} fill="none" stroke="var(--green)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== null && <line x1={xy[hover][0]} x2={xy[hover][0]} y1="0" y2={H} stroke="var(--muted)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      {refPrice !== undefined && refLabel && (
        <span className="ref-tag" style={{ top: `${(y(refPrice) / H) * 100}%` }}>
          {refLabel} {rate(refPrice)}
        </span>
      )}
      {/* Marcas em HTML, por cima: o SVG estica sem manter a proporção e deformaria o triângulo. */}
      {inRange.map((m, k) => (
        <span
          key={k}
          className="buy-mark"
          style={{ left: `${Math.min(100, ((m.t - t0) / span) * 100)}%`, top: `${(y(m.price) / H) * 100}%` }}
          title={`Sua compra a ${rate(m.price)}`}
          aria-hidden
        />
      ))}
      <span className="chart-dot" style={{ left: `${(dot[0] / W) * 100}%`, top: `${(dot[1] / H) * 100}%` }} aria-hidden />
    </div>
  );
}
