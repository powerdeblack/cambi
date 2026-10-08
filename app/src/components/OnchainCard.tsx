import { useEffect, useState } from "react";
import deployment from "../devnet.json";
import { reais } from "../format";
import { OnchainPool, fetchPool, fetchTokenBalance } from "../onchain";

interface Deployment {
  rpc: string;
  programId: string | null;
  pool: string | null;
  brlVault: string | null;
  usdVault: string | null;
  transactions: { label: string; url: string }[];
  links: { program: string; pool: string } | null;
}

type State =
  | { status: "loading" }
  | { status: "ok"; pool: OnchainPool; brl: number; usd: number }
  | { status: "error"; message: string };

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function OnchainCard() {
  const d = deployment as unknown as Deployment;
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!d.pool || !d.brlVault || !d.usdVault) return;
    let alive = true;
    Promise.all([fetchPool(d.rpc, d.pool), fetchTokenBalance(d.rpc, d.brlVault), fetchTokenBalance(d.rpc, d.usdVault)])
      .then(([pool, brl, usd]) => alive && setState({ status: "ok", pool, brl, usd }))
      .catch((e: Error) => alive && setState({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, [d.pool, d.brlVault, d.usdVault, d.rpc]);

  if (!d.pool || !d.programId || !d.links) {
    return (
      <section className="card">
        <h3>Na blockchain</h3>
        <p className="muted">O programa ainda não foi implantado na devnet. Esta tela simula o pool no seu navegador.</p>
      </section>
    );
  }

  const links = d.links;
  return (
    <section className="card onchain">
      <div className="onchain-head">
        <span className="live-dot" aria-hidden />
        <h3>Ao vivo na Solana devnet</h3>
      </div>
      {state.status === "loading" && <p className="muted">Lendo o pool na blockchain…</p>}
      {state.status === "error" && (
        <p className="muted">Não foi possível ler a devnet agora ({state.message}). Os links abaixo continuam válidos.</p>
      )}
      {state.status === "ok" && (
        <div className="stats">
          <div className="stat">
            <span className="muted">Cotação do oráculo</span>
            <strong>{reais(state.pool.price)}</strong>
          </div>
          <div className="stat">
            <span className="muted">Trocas registradas</span>
            <strong>{state.pool.swapCount}</strong>
          </div>
          <div className="stat">
            <span className="muted">Cofre em reais</span>
            <strong>{state.brl.toLocaleString("pt-BR")} cBRL</strong>
          </div>
          <div className="stat">
            <span className="muted">Cofre em dólar</span>
            <strong>{state.usd.toLocaleString("pt-BR")} cUSD</strong>
          </div>
          <div className="stat">
            <span className="muted">Volume</span>
            <strong>{reais(state.pool.volumeBRL)}</strong>
          </div>
          <div className="stat">
            <span className="muted">Status</span>
            <strong>{state.pool.paused ? "Pausado" : "Ativo"}</strong>
          </div>
        </div>
      )}
      <ul className="list proofs">
        <li>
          <span>Programa</span>
          <a href={links.program} target="_blank" rel="noreferrer">{short(d.programId)} ↗</a>
        </li>
        <li>
          <span>Pool</span>
          <a href={links.pool} target="_blank" rel="noreferrer">{short(d.pool)} ↗</a>
        </li>
        {d.transactions.map((t) => (
          <li key={t.url}>
            <span>{t.label}</span>
            <a href={t.url} target="_blank" rel="noreferrer">ver ↗</a>
          </li>
        ))}
      </ul>
      <p className="muted small">Moedas de teste (cBRL e cUSD) sem valor real. Qualquer pessoa pode conferir no Solana Explorer.</p>
    </section>
  );
}
