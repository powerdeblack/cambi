import { useEffect, useRef, useState } from "react";

export interface Series {
  id: string;
  label: string;
  values: number[];
  /** Linha tracejada: segunda forma de distinguir a série, além da cor. */
  dashed?: boolean;
}

interface Props {
  series: Series[];
  /** Rótulo do ponto i no eixo x e no tooltip (ex.: "mês 6"). */
  xLabel: (i: number) => string;
  format: (v: number) => string;
  formatAxis: (v: number) => string;
  label: string; // descrição para leitor de tela
  height?: number;
  /** Pontos marcados na primeira série (ex.: depósitos), com legenda própria. */
  markers?: { i: number; label: string }[];
}

const PAD = { top: 12, right: 12, bottom: 22, left: 52 };

/**
 * Gráfico de linhas com cruz e tooltip ao passar o dedo ou o mouse, linhas de grade discretas e rótulo no fim de cada
 * linha. As cores vêm de --series-1..3 (paleta validada para daltonismo e contraste nos dois temas).
 */
export function LineChart({ series, xLabel, format, formatAxis, label, height = 200, markers = [] }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = series[0]?.values.length ?? 0;
  if (n < 2) return null;
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || hi * 0.1 || 1;
  // Valores que nunca são negativos (acumulados) não ganham eixo abaixo de zero.
  const yMin = lo >= 0 ? Math.max(0, lo - span * 0.08) : lo - span * 0.08;
  const yMax = hi + span * 0.08;
  const ticks = [0, 0.5, 1].map((t) => yMin + (yMax - yMin) * t);
  // Margem esquerda cresce com o rótulo mais longo do eixo (ex.: 0,000052), para não cortar.
  const left = Math.max(PAD.left, Math.max(...ticks.map((t) => formatAxis(t).length)) * 6.2 + 10);
  const iw = width - left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (i: number) => left + (i / (n - 1)) * iw;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const xTicks = [0, Math.round((n - 1) / 2), n - 1];

  function scrub(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const i = Math.round(((px - left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const hx = hover !== null ? x(hover) : 0;
  // A caixa fica do lado oposto ao dedo, para não cobrir as linhas perto do ponto escolhido.
  const tipLeft = hover === null ? 0 : hx > width / 2 ? Math.max(0, hx - 222) : Math.min(hx + 12, width - 210);

  return (
    <div
      ref={box}
      className="line-chart"
      onPointerMove={scrub}
      onPointerDown={scrub}
      onPointerLeave={() => setHover(null)}
      role="img"
      aria-label={label}
    >
      <svg width={width} height={height} aria-hidden>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" className="axis">
              {formatAxis(t)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="axis">
            {xLabel(i)}
          </text>
        ))}
        {/* A série principal (índice 0) é desenhada por último, por cima das outras. */}
        {[...series].reverse().map((s) => {
          const k = series.indexOf(s) + 1;
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          return <path key={s.id} d={d} className={`line s${k}${s.dashed ? " dashed" : ""}`} />;
        })}
        {markers.map((m) => {
          const cx = x(m.i);
          const cy = y(series[0].values[m.i]);
          return <path key={`m${m.i}`} d={`M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} Z`} className="marker" />;
        })}
        {hover !== null && (
          <>
            <line x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + ih} className="crosshair" />
            {series.map((s, k) => (
              <circle key={s.id} cx={hx} cy={y(s.values[hover])} r={4.5} className={`dot s${k + 1}`} />
            ))}
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: tipLeft }}>
          <strong>{xLabel(hover)}</strong>
          {markers.filter((m) => m.i === hover).map((m) => (
            <em key={m.label}>◆ {m.label}</em>
          ))}
          {series.map((s, k) => (
            <span key={s.id}>
              <i className={`key s${k + 1}${s.dashed ? " dashed" : ""}`} /> {s.label}
              <b>{format(s.values[hover])}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
