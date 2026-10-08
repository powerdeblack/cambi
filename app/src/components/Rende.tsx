import { useState } from "react";
import { Side } from "../engine/pool";
import { project } from "../engine/projection";
import { money, pct } from "../format";
import { Wallet } from "../wallet";
import { Brand } from "./Brand";
import { InfoIcon } from "./Icons";
import { MoneyInput } from "./MoneyInput";

const CDI = 0.1365;
const TBILL = 0.0386;

interface Props {
  wallet: Wallet;
  onDeposit: (side: Side, amount: number) => void | Promise<void>;
  /** Modo blockchain: colher as taxas e resgatar a posição de verdade. */
  onchain?: { onHarvest: () => Promise<void>; onWithdraw: () => Promise<void>; unlockAt?: number };
}

export function Rende({ wallet, onDeposit, onchain }: Props) {
  const [tier, setTier] = useState<"rende" | "baleia">("rende");
  const [side, setSide] = useState<Side>("BRL");
  const [cents, setCents] = useState(10_000);
  const amount = cents / 100;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "deposit" | "harvest" | "withdraw">("");
  const [done, setDone] = useState("");
  const [giro, setGiro] = useState(0.05);
  const r = project({ poolBRL: 100e6, giro, cdi: CDI, tbill: TBILL });
  const yearly = amount * (side === "BRL" ? r.rendeBRL : r.rendeUSD);
  const common = amount * (side === "BRL" ? CDI : TBILL);

  async function act(kind: "deposit" | "harvest" | "withdraw", fn: () => void | Promise<void>, ok: string) {
    setBusy(kind);
    setError("");
    setDone("");
    try {
      await fn();
      setDone(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const over = amount > wallet.balance[side] + 1e-9;

  return (
    <>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={tier === "rende"} className={tier === "rende" ? "on" : ""} onClick={() => setTier("rende")}>
          🟢 Rende
        </button>
        <button role="tab" aria-selected={tier === "baleia"} className={tier === "baleia" ? "on" : ""} onClick={() => setTier("baleia")}>
          🐋 Baleia
        </button>
      </div>

      {tier === "baleia" ? (
        <section className="card">
          <h2>Baleia</h2>
          <p>
            Para investidores qualificados. O dinheiro fica líquido e é o motor das trocas: assume o risco de desequilíbrio
            do pool e, por isso, fica com a maior parte das taxas.
          </p>
          <div className="stat-hero">
            <span className="label">Retorno simulado (movimento de {pct(giro)}/dia)</span>
            <strong className="big">{pct(r.baleia)} a.a.</strong>
          </div>
          <p className="warn">Pode ter retorno negativo em crises cambiais. Não disponível nesta demonstração.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>
              <Brand /> Rende
            </h2>
            <p className="muted">
              Seu dinheiro fica aplicado em renda fixa e ainda recebe parte da taxa de cada troca do pool.
            </p>
            {(wallet.rende.BRL > 0 || wallet.rende.USD > 0) && (
              <div className="position">
                <div>
                  <span className="label">Depositado</span>
                  <strong>{money("BRL", wallet.rende.BRL)}</strong>
                  {wallet.rende.USD > 0 && <strong>{money("USD", wallet.rende.USD)}</strong>}
                </div>
                <div>
                  <span className="label">Ganho com câmbio</span>
                  <strong className="pos">+{money("BRL", wallet.earned.BRL)}</strong>
                  {wallet.earned.USD > 0 && <strong className="pos">+{money("USD", wallet.earned.USD)}</strong>}
                </div>
              </div>
            )}

            {onchain && (wallet.rende.BRL > 0 || wallet.rende.USD > 0) && (
              <div className="actions-row">
                <button className="secondary" disabled={!!busy} onClick={() => act("harvest", onchain.onHarvest, "Rendimento enviado para sua carteira.")}>
                  {busy === "harvest" ? "Recebendo…" : "Receber rendimento"}
                </button>
                <button
                  className="secondary"
                  disabled={!!busy || (onchain.unlockAt ?? 0) * 1000 > Date.now()}
                  onClick={() => act("withdraw", onchain.onWithdraw, "Resgate concluído.")}
                >
                  {busy === "withdraw" ? "Resgatando…" : "Resgatar tudo"}
                </button>
              </div>
            )}
            {onchain && (onchain.unlockAt ?? 0) * 1000 > Date.now() && (
              <p className="muted small">
                Por segurança, o principal fica travado por alguns minutos após cada depósito. Resgate liberado às{" "}
                {new Date(onchain.unlockAt! * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. O
                rendimento pode ser recebido a qualquer momento.
              </p>
            )}

            <div className="field-box">
              <div className="amount-row">
                <MoneyInput side={side} cents={cents} onChange={setCents} label="Quanto você quer deixar rendendo" invalid={over} />
                <select className="currency" value={side} onChange={(e) => setSide(e.target.value as Side)} aria-label="Moeda">
                  <option value="BRL">🇧🇷 BRL</option>
                  <option value="USD">🇺🇸 USD</option>
                </select>
              </div>
              <span className={over ? "error" : "muted"}>Disponível: {money(side, wallet.balance[side])} · mínimo R$ 10</span>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            {done && <p className="pos" role="status">{done}</p>}
            <button
              className="primary"
              disabled={!(amount > 0) || over || !!busy}
              onClick={() => act("deposit", () => onDeposit(side, amount), "Depósito feito. Agora você ganha com as trocas do pool.")}
            >
              {busy === "deposit" ? (
                <>
                  <span className="spinner tiny" aria-hidden /> Confirmando na Solana…
                </>
              ) : (
                <>Depositar {amount > 0 ? money(side, amount) : ""}</>
              )}
            </button>
            <p className="warn">
              <InfoIcon /> Não tem garantia do FGC, ao contrário de um CDB. Rendimentos dependem do movimento do pool e não são
              garantidos.
            </p>
          </section>

          <section className="card">
            <h3>Quanto você ganharia em 1 ano?</h3>
            <div className="compare-hero">
              <div>
                <span className="label">Conta comum</span>
                <strong>{money(side, common)}</strong>
              </div>
              <div className="ours">
                <span className="label">
                  <Brand /> Rende
                </span>
                <strong>{money(side, yearly)}</strong>
                <span className="pos">+{money(side, yearly - common)}</span>
              </div>
            </div>
            <label className="slider">
              <span>
                Movimento do pool: <strong>{pct(giro)} por dia</strong>
              </span>
              <input type="range" min={0.01} max={0.1} step={0.005} value={giro} onChange={(e) => setGiro(Number(e.target.value))} />
              <span className="scale">
                <span>pouco</span>
                <span>muito</span>
              </span>
            </label>
            <p className="muted small">
              Simulação, não promessa. Premissas: pool de R$ 100 mi, CDI {pct(CDI)}, Tesouro americano {pct(TBILL)}, 60% do
              volume de apps parceiros. A <Brand /> só cobra 20% do que passar de 100% do CDI. Antes de IR e IOF.
            </p>
          </section>
        </>
      )}
    </>
  );
}

