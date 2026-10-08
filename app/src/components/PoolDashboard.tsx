import { PoolState, imbalance, totalValueBRL } from "../engine/pool";
import { money, pct, reais } from "../format";

export function PoolDashboard({ pool }: { pool: PoolState }) {
  const total = totalValueBRL(pool);
  const brlShare = total === 0 ? 0.5 : pool.liquid.BRL / total;
  const imb = imbalance(pool);
  const earned = (k: "rende" | "baleia") => pool.fees[k].BRL + pool.fees[k].USD * pool.price;

  return (
    <section className="card">
      <h2>Pool ao vivo</h2>
      <p className="muted">Tudo aqui é público. No programa on-chain, qualquer pessoa pode conferir estes números.</p>

      <div className="split" role="img" aria-label={`Real ${pct(brlShare)}, dólar ${pct(1 - brlShare)}`}>
        <span className="brl" style={{ width: `${brlShare * 100}%` }}>
          Real {pct(brlShare)}
        </span>
        <span className="usd" style={{ width: `${(1 - brlShare) * 100}%` }}>
          Dólar {pct(1 - brlShare)}
        </span>
      </div>
      <p className="muted">
        {Math.abs(imb) < 0.05
          ? "Pool equilibrado: as taxas estão no valor base."
          : imb > 0
            ? "Sobra real no pool: trocar dólar por real está mais barato agora."
            : "Sobra dólar no pool: trocar real por dólar está mais barato agora."}
      </p>

      <div className="stats">
        <Stat label="Valor no pool" value={reais(total)} />
        <Stat label="Real líquido" value={money("BRL", pool.liquid.BRL)} />
        <Stat label="Dólar líquido" value={money("USD", pool.liquid.USD)} />
        <Stat label="Trocas" value={String(pool.swaps)} />
        <Stat label="Volume" value={reais(pool.volumeBRL)} />
        <Stat label="Ganho da Rende" value={reais(earned("rende"))} />
        <Stat label="Ganho da Baleia" value={reais(earned("baleia"))} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
