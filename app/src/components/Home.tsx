import { PoolState } from "../engine/pool";
import { money, reais } from "../format";
import { Wallet, isDepositor } from "../wallet";
import { Brand } from "./Brand";
import { GrowIcon, SendIcon, SwapIcon } from "./Icons";

interface Props {
  pool: PoolState;
  wallet: Wallet;
  go: (tab: "trocar" | "rende") => void;
  onSend: () => void;
  onSimulateMarket?: () => void;
}

const ACTIVITY_ICON = { swap: "⇄", deposit: "＋", send: "↗", harvest: "✦", withdraw: "↙", faucet: "🎁" } as const;

function activityTitle(a: Wallet["activity"][number]) {
  if (a.kind === "swap") return `Troca ${a.side === "BRL" ? "real → dólar" : "dólar → real"}`;
  if (a.kind === "deposit") return "Depósito na Rende";
  if (a.kind === "harvest") return "Rendimento recebido";
  if (a.kind === "withdraw") return "Resgate da Rende";
  if (a.kind === "faucet") return "Moedas de teste recebidas";
  return a.route === "Pix" ? "Pix enviado" : a.route === "ACH" ? "Envio para conta nos EUA" : "Envio para carteira USDC";
}

export function Home({ pool, wallet, go, onSend, onSimulateMarket }: Props) {
  const p = pool.price;
  const free = wallet.balance.BRL + wallet.balance.USD * p;
  const invested = wallet.rende.BRL + wallet.rende.USD * p;
  const earned = wallet.earned.BRL + wallet.earned.USD * p;

  return (
    <>
      <section className="balance-card">
        <span className="label">Seu patrimônio</span>
        <strong className="big">{reais(free + invested + earned)}</strong>
        <div className="balance-split">
          <span>Disponível {reais(free)}</span>
          <span>Na Rende {reais(invested)}</span>
        </div>
        {isDepositor(wallet) && (
          <div className="earned-chip">+ {reais(earned)} ganhos com o câmbio dos outros</div>
        )}
      </section>

      <div className="quick-actions">
        <button onClick={() => go("trocar")}>
          <span className="qa-icon"><SwapIcon /></span>
          Trocar
        </button>
        <button onClick={onSend}>
          <span className="qa-icon"><SendIcon /></span>
          Enviar
        </button>
        <button onClick={() => go("rende")}>
          <span className="qa-icon"><GrowIcon /></span>
          Render
        </button>
      </div>

      <section className="card">
        <h3>Suas moedas</h3>
        <ul className="list">
          <li>
            <span className="flag">🇧🇷</span>
            <span>Real</span>
            <strong>{money("BRL", wallet.balance.BRL)}</strong>
          </li>
          <li>
            <span className="flag">🇺🇸</span>
            <span>Dólar digital</span>
            <strong>{money("USD", wallet.balance.USD)}</strong>
          </li>
        </ul>
      </section>

      {isDepositor(wallet) ? (
        <section className="card hint">
          <p>
            Você é dono de um pedaço do câmbio. Quando outras pessoas trocam, parte da taxa vem para você.
          </p>
          {onSimulateMarket && (
            <button className="secondary" onClick={onSimulateMarket}>
              Simular um dia de trocas no pool
            </button>
          )}
        </section>
      ) : (
        <section className="card hint">
          <p>
            Hoje, quem lucra com o câmbio é o banco. Na <Brand />, deixando a partir de R$ 10 na Rende, você passa a
            ganhar com as trocas dos outros e paga metade da taxa.
          </p>
          <button className="secondary" onClick={() => go("rende")}>
            Quero ser dono
          </button>
        </section>
      )}

      <section className="card">
        <h3>Atividade</h3>
        {wallet.activity.length === 0 ? (
          <p className="muted">Nenhuma movimentação ainda. Que tal fazer sua primeira troca?</p>
        ) : (
          <ul className="list activity">
            {wallet.activity.slice(0, 6).map((a) => (
              <li key={a.id}>
                <span className={`flag act-${a.kind}`}>{ACTIVITY_ICON[a.kind]}</span>
                <span>
                  {activityTitle(a)}
                  {a.kind === "send" && a.to && <small className="muted">{a.to}</small>}
                  {a.savedVsBank !== undefined && (
                    <small className="saved">economizou {reais(a.savedVsBank)} vs. banco</small>
                  )}
                  {a.sig && (
                    <a className="chain-link" href={`https://explorer.solana.com/tx/${a.sig}?cluster=devnet`} target="_blank" rel="noreferrer">
                      ver na blockchain ↗
                    </a>
                  )}
                </span>
                <strong className={a.kind === "send" ? "neg" : undefined}>
                  {a.kind === "send" ? "− " : ""}
                  {money(a.side, a.amountIn)}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
