import { useEffect, useState } from "react";
import deployment from "../devnet.json";
import { explorerAddress, explorerTx, poolAuthorities } from "../chain/client";
import { money } from "../format";

interface Member {
  name: string;
  key: string;
}
interface Validation {
  index: number;
  action: string;
  at: string;
  approvals: number;
  createSignature: string;
  approveSignature: string;
  executeSignature: string;
}
interface Consortium {
  multisig: string;
  vault: string;
  threshold: number;
  members: Member[];
  validations: Validation[];
}
interface Security {
  levelLimitsBRL: number[];
  breaker: { windowSecs: number; bps: number };
  instantWithdrawBps: number;
  withdrawNoticeSecs: number;
  rendeReserveBps: number;
}
interface Deployment {
  consortium?: Consortium;
  security?: Security;
  liquidity?: { baleias: { brl: number; usd: number }[]; rendeBRL: number };
  guardianProgramId?: string;
  upgradeAuthority?: string;
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Governança do pool v2.6: um conselho de teste (7 de 10) cuida da cotação e das regras; o guardião é um programa sem chave. */
export function ConsortiumCard() {
  const dep = deployment as unknown as Deployment;
  const c = dep.consortium;
  const sec = dep.security;
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
  const baleias = dep.liquidity?.baleias ?? [];
  const totalBRL = baleias.reduce((a, b) => a + b.brl, 0);
  const validations = [...c.validations].sort((a, b) => b.index - a.index);

  return (
    <section className="card consortium">
      <div className="onchain-head">
        <span className="live-dot" aria-hidden />
        <h3>Conselho e guardião</h3>
      </div>
      <p className="muted">
        O pool não tem dono único. A cotação e as regras só mudam com <strong>{c.threshold} de {c.members.length}</strong>{" "}
        assinaturas do conselho. Na devnet, um conselho de teste faz esse papel.
      </p>

      <p className={`gov-check ${check}`} role="status">
        {check === "loading" && "Conferindo na blockchain quem governa o pool…"}
        {check === "ok" && "✓ Conferido agora na Solana: admin e oráculo do pool são o cofre do conselho."}
        {check === "differs" && "Atenção: o admin ou o oráculo do pool não é o cofre do conselho."}
        {check === "error" && "Não deu para consultar a devnet agora. Confira pelos links abaixo."}
      </p>

      {baleias.length > 0 && (
        <>
          <div className="baleias" role="list" aria-label="Baleias do pool">
            {baleias.map((b, i) => (
              <span key={i} role="listitem" className="whale-chip">
                <span className="baleia-n">{i + 1}</span>
                <small>R$ {b.brl >= 1000 ? `${Math.round(b.brl / 1000)} mil` : b.brl}</small>
              </span>
            ))}
          </div>
          <p className="muted small">
            {baleias.length} Baleias somam {money("BRL", totalBRL)} em reais e o equivalente em dólar. Elas recebem a maior
            parte das taxas e são as últimas a sair numa corrida (tranche júnior).
          </p>
        </>
      )}

      <h4 className="sub">Validações do conselho na rede</h4>
      <ul className="list validations">
        {validations.map((v) => (
          <li key={v.index}>
            <span className="v-idx">#{v.index}</span>
            <span>
              <strong>{v.action}</strong>
              <small className="muted">
                {when(v.at)} · {v.approvals} de {c.members.length} assinaram
              </small>
              <span className="v-links">
                <a href={explorerTx(v.createSignature)} target="_blank" rel="noreferrer">proposta ↗</a>
                <a href={explorerTx(v.approveSignature)} target="_blank" rel="noreferrer">assinaturas ↗</a>
                <a href={explorerTx(v.executeSignature)} target="_blank" rel="noreferrer">execução ↗</a>
              </span>
            </span>
          </li>
        ))}
      </ul>

      <ul className="list proofs">
        <li>
          <span>Conselho (Squads v4)</span>
          <a href={explorerAddress(c.multisig)} target="_blank" rel="noreferrer">{short(c.multisig)} ↗</a>
        </li>
        <li>
          <span>Cofre (admin e oráculo)</span>
          <a href={explorerAddress(c.vault)} target="_blank" rel="noreferrer">{short(c.vault)} ↗</a>
        </li>
        {dep.guardianProgramId && (
          <li>
            <span>Programa guardião (sem chave)</span>
            <a href={explorerAddress(dep.guardianProgramId)} target="_blank" rel="noreferrer">{short(dep.guardianProgramId)} ↗</a>
          </li>
        )}
      </ul>
      {sec && (
        <>
          <h4 className="sub">Proteções do pool</h4>
          <ul className="safety-list">
            <li>Só carteira com credencial de identidade troca e deposita. Teto por operação: {money("BRL", sec.levelLimitsBRL[0]).replace(",00", "")} no nível básico, {money("BRL", sec.levelLimitsBRL[1]).replace(",00", "")} no completo.</li>
            <li>Disjuntor: no máximo {sec.breaker.bps / 100}% da liquidez de cada moeda sai por {Math.round(sec.breaker.windowSecs / 60)} min.</li>
            <li>Saque na hora até {sec.instantWithdrawBps / 100}% da liquidez; acima disso, fila com aviso de {Math.round(sec.withdrawNoticeSecs / 60)} min e valor reservado.</li>
            <li>Reserva da Rende: {sec.rendeReserveBps / 100}% do principal da Rende fica em cada moeda, fora das trocas.</li>
            <li>Guardião: um programa sem chave que qualquer pessoa aciona. Ele trava por tempo: respiro de 15 min numa moeda que sai rápido demais, descanso de 1 h num salto de cotação e parada se faltar lastro. Saques seguem liberados.</li>
          </ul>
        </>
      )}
      {dep.upgradeAuthority && (
        <p className="warn-box small">
          Ainda falta: na devnet, o código do v2.6 ainda pode ser atualizado pela chave de quem implantou. A versão final (v3) fica
          imutável depois das auditorias.
        </p>
      )}
    </section>
  );
}
