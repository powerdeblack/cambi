import metrics from "../metrics-v2.json";
import { money } from "../format";

interface Metrics {
  updatedAt: string | null;
  northStar: { activeWallets7d: number; activeWallets30d: number };
  swaps: number;
  volumeBRL: number;
  volume7dBRL: number;
  feesBRL: { total: number; rende: number; baleia: number; platform: number; partner: number };
  rende: { deposits: number; withdrawals: number; queueRequests: number; queueClaims: number };
  compliance: { credentialsIssued: number; credentialsRevoked: number; freezes: number };
  safety: { pauses: number; rejectsByReason: Record<string, number> };
  daily: { day: string; swaps: number; volumeBRL: number }[];
}

/** Produto medido: números agregados lidos da blockchain pelo indexador (nenhuma carteira identificada). */
export function MetricsCard() {
  const m = metrics as unknown as Metrics;
  if (!m.updatedAt) return null;
  const days = m.daily.slice(-14);
  const max = Math.max(1, ...days.map((d) => d.volumeBRL));
  return (
    <section className="card metrics">
      <h3>Produto medido</h3>
      <div className="kpi-grid">
        <div>
          <span className="label">Carteiras ativas (7 dias)</span>
          <strong className="kpi">{m.northStar.activeWallets7d}</strong>
        </div>
        <div>
          <span className="label">Volume (7 dias)</span>
          <strong className="kpi">{money("BRL", m.volume7dBRL)}</strong>
        </div>
        <div>
          <span className="label">Trocas no total</span>
          <strong className="kpi">{m.swaps}</strong>
        </div>
        <div>
          <span className="label">Taxas geradas</span>
          <strong className="kpi">{money("BRL", m.feesBRL.total)}</strong>
        </div>
      </div>
      {days.length > 0 && (
        <div className="spark" role="img" aria-label={`Volume por dia nos últimos ${days.length} dias`}>
          {days.map((d) => (
            <span key={d.day} title={`${d.day}: ${money("BRL", d.volumeBRL)} em ${d.swaps} trocas`} style={{ height: `${Math.max(4, (d.volumeBRL / max) * 100)}%` }} />
          ))}
        </div>
      )}
      <ul className="list proofs">
        <li>
          <span>Taxas para a Rende / Baleias</span>
          <strong>
            {money("BRL", m.feesBRL.rende)} / {money("BRL", m.feesBRL.baleia)}
          </strong>
        </li>
        <li>
          <span>Depósitos na Rende · pedidos na fila de saque</span>
          <strong>
            {m.rende.deposits} · {m.rende.queueRequests}
          </strong>
        </li>
        <li>
          <span>Credenciais emitidas · revogadas · bloqueios</span>
          <strong>
            {m.compliance.credentialsIssued} · {m.compliance.credentialsRevoked} · {m.compliance.freezes}
          </strong>
        </li>
        <li>
          <span>Pausas de emergência</span>
          <strong>{m.safety.pauses}</strong>
        </li>
      </ul>
      <p className="muted small">
        Lido da blockchain em {new Date(m.updatedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}. Rede de testes;
        só números agregados, nenhuma carteira identificada.
      </p>
    </section>
  );
}
