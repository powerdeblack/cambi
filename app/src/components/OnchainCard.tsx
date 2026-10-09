import deployment from "../devnet.json";

interface Deployment {
  rpc: string;
  programId: string | null;
  pool: string | null;
  brlVault: string | null;
  usdVault: string | null;
  transactions: { label: string; url: string }[];
  links: { program: string; pool: string } | null;
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function OnchainCard() {
  const d = deployment as unknown as Deployment;

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
        <h3>Confira na Solana</h3>
      </div>
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
      <p className="muted small">
        Programa, pool e cada operação de teste da implantação, com link público. Moedas de teste (cBRL e cUSD) sem valor
        real. Qualquer pessoa pode conferir no Solana Explorer.
      </p>
    </section>
  );
}
