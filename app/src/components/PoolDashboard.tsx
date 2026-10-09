import { useState } from "react";
import { BALEIA_SHARE_OF_LP, BASE_FEE, PARTNER_COST, PLATFORM_SHARE, PoolState, Side, dynamicFeeRate, imbalance, totalValueBRL } from "../engine/pool";
import { CDI, TBILL, feeSplitPer100, growthSeries } from "../engine/growth";
import { project } from "../engine/projection";
import { money, pct, reais } from "../format";
import { Brand } from "./Brand";
import { LineChart } from "./LineChart";
import { MoneyInput } from "./MoneyInput";

const PERIODS = [
  { months: 6, label: "6 meses" },
  { months: 12, label: "1 ano" },
  { months: 24, label: "2 anos" },
  { months: 60, label: "5 anos" },
];

const compact = (side: Side) => (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: side, notation: "compact", maximumFractionDigits: 1 });
/** Eixo: só o número (a moeda já está no título e na legenda), para caber no celular. */
const axis = (v: number) => v.toLocaleString("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

/** Aba Pool: números do pool, simulador de rendimento, para onde vai a taxa e a taxa dinâmica ao vivo. */
export function PoolDashboard({ pool }: { pool: PoolState }) {
  return (
    <>
      <PoolHero pool={pool} />
      <YieldSimulator />
      <FeeFlow />
      <PoolBalance pool={pool} />
    </>
  );
}

function PoolHero({ pool }: { pool: PoolState }) {
  const total = totalValueBRL(pool);
  const yearly = project({ poolBRL: 100e6, giro: 0.05, cdi: CDI, tbill: TBILL }).rendeBRL;
  const lpEarned = pool.fees.rende.BRL + pool.fees.rende.USD * pool.price + pool.fees.baleia.BRL + pool.fees.baleia.USD * pool.price;
  return (
    <section className="balance-card pool-hero">
      <span className="label">Valor no pool (simulação)</span>
      <strong className="big">{reais(total)}</strong>
      <div className="hero-tiles">
        <div>
          <small>Rende estimada</small>
          <strong>{pct(yearly)} a.a.</strong>
          <small>{pct(yearly / CDI)} do CDI</small>
        </div>
        <div>
          <small>Volume trocado</small>
          <strong>{pool.swaps ? compact("BRL")(pool.volumeBRL) : "—"}</strong>
          <small>{pool.swaps ? `${pool.swaps} ${pool.swaps === 1 ? "troca" : "trocas"}` : "faça a 1ª troca"}</small>
        </div>
        <div>
          <small>Pago aos donos</small>
          <strong>{lpEarned ? compact("BRL")(lpEarned) : "—"}</strong>
          <small>Rende + Baleia</small>
        </div>
      </div>
    </section>
  );
}

/** Quanto o seu dinheiro viraria na cambI Rende, contra o CDI (ou T-bill) e o dinheiro parado. */
function YieldSimulator() {
  const [currency, setCurrency] = useState<Side>("BRL");
  const [cents, setCents] = useState(1_000_000);
  const [months, setMonths] = useState(12);
  const [giro, setGiro] = useState(0.05);
  const amount = cents / 100;
  const series = growthSeries(Math.max(amount, 0), months, giro, currency).map((s) => ({
    ...s,
    dashed: s.id === "base",
  }));
  const [ours, bench, base] = series;
  const end = (s: (typeof series)[number]) => s.values[s.values.length - 1];
  const extra = end(ours) - end(base);
  const fmt = (v: number) => money(currency, v);

  return (
    <section className="card yield-sim viz">
      <div className="card-head">
        <h3>Simule seu rendimento</h3>
        <div className="chips tight" role="group" aria-label="Moeda">
          {(["BRL", "USD"] as Side[]).map((c) => (
            <button key={c} className={`chip${currency === c ? " on" : ""}`} aria-pressed={currency === c} onClick={() => setCurrency(c)}>
              {c === "BRL" ? "🇧🇷 Real" : "🇺🇸 Dólar"}
            </button>
          ))}
        </div>
      </div>

      <MoneyInput side={currency} cents={cents} onChange={setCents} label="Se eu deixar" />

      <div className="chips scroll" role="group" aria-label="Prazo">
        {PERIODS.map((p) => (
          <button key={p.months} className={`chip${months === p.months ? " on" : ""}`} aria-pressed={months === p.months} onClick={() => setMonths(p.months)}>
            {p.label}
          </button>
        ))}
      </div>

      {amount > 0 && (
        <>
          <p className="sim-headline">
            Em {PERIODS.find((p) => p.months === months)?.label}, <Brand /> Rende: <strong>{fmt(end(ours))}</strong>
            <span className="saved">
              {" "}
              {extra >= 0 ? "+" : "−"} {fmt(Math.abs(extra))} a mais que {currency === "BRL" ? "na poupança" : "com o dólar parado"}
            </span>
          </p>
          <LineChart
            series={series}
            xLabel={(i) => (i === 0 ? "hoje" : i % 12 === 0 ? `${i / 12} ${i === 12 ? "ano" : "anos"}` : `mês ${i}`)}
            format={fmt}
            formatAxis={axis}
            label={`Projeção em ${months} meses: ${series.map((s) => `${s.label} ${fmt(end(s))}`).join(", ")}`}
          />
          <ul className="viz-legend">
            {series.map((s, k) => (
              <li key={s.id}>
                <i className={`key s${k + 1}${s.dashed ? " dashed" : ""}`} aria-hidden />
                <span>
                  {s.label}
                  <small className="muted">{pct(s.rate)} ao ano</small>
                </span>
                <strong>{fmt(end(s))}</strong>
              </li>
            ))}
          </ul>
        </>
      )}

      <label className="slider">
        <span>
          Movimento do pool: <strong>{pct(giro)} do pool trocado por dia</strong>
        </span>
        <input type="range" min={0.01} max={0.1} step={0.005} value={giro} onChange={(e) => setGiro(Number(e.target.value))} aria-label="Movimento do pool por dia" />
        <span className="scale">
          <span>pouco movimento</span>
          <span>muito movimento</span>
        </span>
      </label>
      <p className="muted small">
        Quanto mais gente troca, mais taxa entra e mais a Rende paga. Taxas brutas, antes de IR: CDI {pct(CDI)}, Tesouro americano{" "}
        {pct(TBILL)}, poupança 0,5% ao mês. Projeção ilustrativa, não é promessa de rendimento. {bench.label} serve de referência.
      </p>
    </section>
  );
}

/** Para onde vai cada R$ 100 de taxa de uma troca de varejo (as mesmas regras do programa na Solana). */
function FeeFlow() {
  const s = feeSplitPer100(1 - BALEIA_SHARE_OF_LP, PLATFORM_SHARE, PARTNER_COST / BASE_FEE.retail);
  const parts = [
    { id: "rende", label: <>Quem deposita na <Brand /> Rende</>, value: s.rende },
    { id: "baleia", label: "Provedores de liquidez (Baleia)", value: s.baleia },
    { id: "partner", label: "Parceiro regulado (Pix)", value: s.partner },
    { id: "platform", label: <><Brand /> (operação)</>, value: s.platform },
  ];
  const [hover, setHover] = useState<string | null>(null);
  const owners = s.rende + s.baleia;
  return (
    <section className="card">
      <h3>Para onde vai cada R$ 100 de taxa</h3>
      <p className="muted small">
        No banco, o spread fica com o banco. Aqui, <strong>{reais(owners)}</strong> de cada R$ 100 voltam para quem é dono do pool.
      </p>
      <div className="bar big-bar" role="img" aria-label={parts.map((p) => `${p.id} ${reais(p.value)}`).join(", ")}>
        {parts.map((p) => (
          <span
            key={p.id}
            className={`${p.id}${hover && hover !== p.id ? " dim" : ""}`}
            style={{ width: `${p.value}%` }}
            onPointerEnter={() => setHover(p.id)}
            onPointerLeave={() => setHover(null)}
            onPointerDown={() => setHover(p.id)}
          />
        ))}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.id} className={hover === p.id ? "on" : undefined} onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover(null)}>
            <i className={p.id} />
            <span>{p.label}</span>
            <strong>{reais(p.value)}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Composição do pool e a taxa dinâmica de cada lado, ao vivo. */
function PoolBalance({ pool }: { pool: PoolState }) {
  const total = totalValueBRL(pool);
  const brlShare = total === 0 ? 0.5 : pool.liquid.BRL / total;
  const imb = imbalance(pool);
  const buyUsd = dynamicFeeRate(pool, "BRL", "retail");
  const sellUsd = dynamicFeeRate(pool, "USD", "retail");
  return (
    <section className="card">
      <h3>Equilíbrio do pool, agora</h3>
      <div className="split" role="img" aria-label={`Real ${pct(brlShare)}, dólar ${pct(1 - brlShare)}`}>
        <span className="brl" style={{ width: `${brlShare * 100}%` }}>
          Real {pct(brlShare)}
        </span>
        <span className="usd" style={{ width: `${(1 - brlShare) * 100}%` }}>
          Dólar {pct(1 - brlShare)}
        </span>
      </div>
      <div className="fee-sides">
        <div className={buyUsd < sellUsd ? "cheaper" : undefined}>
          <small>Comprar dólar</small>
          <strong>{pct(buyUsd)}</strong>
          {buyUsd < sellUsd && <span className="saved">mais barato agora</span>}
        </div>
        <div className={sellUsd < buyUsd ? "cheaper" : undefined}>
          <small>Vender dólar</small>
          <strong>{pct(sellUsd)}</strong>
          {sellUsd < buyUsd && <span className="saved">mais barato agora</span>}
        </div>
      </div>
      <p className="muted small">
        {Math.abs(imb) < 0.05
          ? "Pool equilibrado: as taxas estão no valor base (varejo 1%)."
          : "A taxa fica mais barata no sentido que equilibra o pool e mais cara no que desequilibra. Assim o próprio mercado reequilibra o pool."}
        {" "}Real {money("BRL", pool.liquid.BRL)} · dólar {money("USD", pool.liquid.USD)}.
      </p>
    </section>
  );
}
