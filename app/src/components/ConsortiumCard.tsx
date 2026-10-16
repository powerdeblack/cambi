import { useEffect, useState } from "react";
import deployment from "../devnet.json";
import { explorerAddress, explorerTx, poolAuthorities } from "../chain/client";
import { money } from "../format";

interface Member {
  name: string;
  key: string;
  depositBRL: number;
  depositUSD: number;
}
interface Validation {
  index: number;
  action: string;
  at: string;
  proposer: string;
  approvals: { member: string; signature: string }[];
  createSignature: string;
  executeSignature: string;
}
interface Consortium {
  multisig: string;
  vault: string;
  threshold: number;
  members: Member[];
  upgradeAuthorityInMultisig: boolean;
  validations: Validation[];
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Consórcio de Baleias: 10 provedores de liquidez com chave própria; 7 precisam assinar cada mudança no pool. */
export function ConsortiumCard() {
  const c = (deployment as unknown as { consortium?: Consortium }).consortium;
  const [check, setCheck] = useState<"loading" | "ok" | "differs" | "error">("loading");

  useEffect(() => {
    if (!c) return;
    let alive = true;
    poolAuthorities()
      .then((a) => alive && setCheck(a.admin === c.vault && a.oracle === c.vault ? "ok" : "differs"))
      .catch(() => alive && setCheck("error"));
    return () => {
      alive = false;
    };
  }, [c]);

  if (!c) return null;
  const nameOf = (key: string) => c.members.find((m) => m.key === key)?.name ?? short(key);
  const totalBRL = c.members.reduce((a, m) => a + m.depositBRL, 0);
  const validations = [...c.validations].sort((a, b) => b.index - a.index);

  return (
    <section className="card consortium">
      <div className="onchain-head">
        <span className="live-dot" aria-hidden />
        <h3>Consórcio de Baleias</h3>
      </div>
      <p className="muted">
        O pool não tem dono único. {c.members.length} Baleias, cada uma com a própria chave, formam uma multisig: qualquer
        mudança de cotação ou de regra só vale com <strong>{c.threshold} de {c.members.length}</strong> assinaturas.
      </p>

      <p className={`gov-check ${check}`} role="status">
        {check === "loading" && "Conferindo na blockchain quem governa o pool…"}
        {check === "ok" && "✓ Conferido agora na Solana: admin e oráculo do pool são o cofre da multisig."}
        {check === "differs" && "Atenção: o admin ou o oráculo do pool não é o cofre da multisig."}
        {check === "error" && "Não deu para consultar a devnet agora. Confira pelos links abaixo."}
      </p>

      <div className="baleias" role="list" aria-label="Baleias do consórcio">
        {c.members.map((m) => (
          <a key={m.key} role="listitem" className="baleia" href={explorerAddress(m.key)} target="_blank" rel="noreferrer">
            <span className="baleia-n">{m.name.replace("Baleia ", "")}</span>
            <small>R$ {m.depositBRL >= 1000 ? `${Math.round(m.depositBRL / 1000)} mil` : m.depositBRL}</small>
          </a>
        ))}
      </div>
      <p className="muted small">
        Liquidez das Baleias: {money("BRL", totalBRL)} em reais e o equivalente em dólar. Elas recebem a maior parte das
        taxas e são as últimas a sair numa corrida (tranche júnior).
      </p>

      <h4 className="sub">Validações na rede</h4>
      <ul className="list validations">
        {validations.map((v) => (
          <li key={v.index}>
            <span className="v-idx">#{v.index}</span>
            <span>
              <strong>{v.action}</strong>
              <small className="muted">
                {when(v.at)} · proposta por {nameOf(v.proposer)} · {v.approvals.length} de {c.members.length} assinaram:{" "}
                {v.approvals.map((a) => nameOf(a.member).replace("Baleia ", "")).join(", ")}
              </small>
              <span className="v-links">
                <a href={explorerTx(v.createSignature)} target="_blank" rel="noreferrer">proposta ↗</a>
                <a href={explorerTx(v.approvals[0]?.signature ?? v.createSignature)} target="_blank" rel="noreferrer">assinaturas ↗</a>
                <a href={explorerTx(v.executeSignature)} target="_blank" rel="noreferrer">execução ↗</a>
              </span>
            </span>
          </li>
        ))}
      </ul>

      <ul className="list proofs">
        <li>
          <span>Multisig (Squads v4)</span>
          <a href={explorerAddress(c.multisig)} target="_blank" rel="noreferrer">{short(c.multisig)} ↗</a>
        </li>
        <li>
          <span>Cofre (admin e oráculo)</span>
          <a href={explorerAddress(c.vault)} target="_blank" rel="noreferrer">{short(c.vault)} ↗</a>
        </li>
      </ul>
      {!c.upgradeAuthorityInMultisig && (
        <p className="warn-box small">
          Ainda falta: o código do programa continua atualizável por uma chave só. O próximo passo é passar essa permissão
          para a multisig, com prazo de espera antes de valer.
        </p>
      )}
    </section>
  );
}
