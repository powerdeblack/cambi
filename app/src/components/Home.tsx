import { PoolState } from "../engine/pool";
import { money, rate, reais } from "../format";
import { dollarResult } from "../position";
import { Wallet, isDepositor } from "../wallet";
import { Brand } from "./Brand";
import { ACTIVITY_ICON, activityTitle } from "../activity";
import { ChevronIcon, GrowIcon, SendIcon, SwapIcon } from "./Icons";

interface Props {
  pool: PoolState;
  wallet: Wallet;
  go: (tab: "trocar" | "rende") => void;
  onSend: () => void;
  onSimulateMarket?: () => void;
  onStatement: () => void;
  onDollars: () => void;
}

export function Home({ pool, wallet, go, onSend, onSimulateMarket, onStatement, onDollars }: Props) {
  const p = pool.price;
  const free = wallet.balance.BRL + wallet.balance.USD * p;
  const invested = wallet.rende.BRL + wallet.rende.USD * p;
  const earned = wallet.earned.BRL + wallet.earned.USD * p;
  const dollars = dollarResult(wallet, p);

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
          <li className="tap">
            <button className="row-btn" onClick={onDollars}>
              <span className="flag">🇺🇸</span>
              <span>
                Dólar digital
                {dollars ? (
                  <small className="muted">preço médio {rate(dollars.avgPrice)}</small>
                ) : (
                  <small className="muted">ver preço médio</small>
                )}
              </span>
              <strong>{money("USD", wallet.balance.USD)}</strong>
              <ChevronIcon />
            </button>
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
        <div className="card-head">
          <h3>Atividade</h3>
          {wallet.activity.length > 0 && (
            <button className="link small-link" onClick={onStatement}>
              Ver extrato
            </button>
          )}
        </div>
        {wallet.activity.length === 0 ? (
          <p className="muted">Nenhuma movimentação ainda. Que tal fazer sua primeira troca?</p>
        ) : (
          <ul className="list activity">
            {wallet.activity.slice(0, 4).map((a) => (
              <li key={a.id}>
                <span className={`flag act-${a.kind}`}>{ACTIVITY_ICON[a.kind]}</span>
                <span>
                  {activityTitle(a)}
                  {a.kind === "send" && a.to && <small className="muted">{a.to}</small>}
                  {a.savedVsBank !== undefined && (
                    <small className="saved">economizou {reais(a.savedVsBank)} vs. banco</small>
                  )}
                  {a.sig && (
                    <a className="chain-link" href={`https://explorer.solana.com/tx/${encodeURIComponent(a.sig)}?cluster=devnet`} target="_blank" rel="noreferrer">
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
