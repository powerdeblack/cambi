import { PoolState } from "../engine/pool";
import { money, rate, reais } from "../format";
import { dollarResult } from "../position";
import { Wallet, isDepositor } from "../wallet";
import { Brand } from "./Brand";
import { ACTIVITY_ICON, activityTitle } from "../activity";
import { BellIcon, ChevronIcon, EyeIcon, EyeOffIcon, GrowIcon, ListIcon, SendIcon, SwapIcon } from "./Icons";
import { ReactNode } from "react";

interface Props {
  pool: PoolState;
  wallet: Wallet;
  go: (tab: "trocar" | "rende") => void;
  onSend: () => void;
  onSimulateMarket?: () => void;
  onStatement: () => void;
  onDollars: () => void;
  onAlert: () => void;
  /** Primeiro nome da pessoa (do cadastro), para a saudação. */
  name?: string;
  hidden: boolean;
  onToggleHidden: () => void;
  /** Conteúdo logo abaixo dos atalhos (cartão do dólar, conta na Solana). */
  afterActions?: ReactNode;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
};


export function Home({ pool, wallet, go, onSend, onSimulateMarket, onStatement, onDollars, onAlert, name, hidden, onToggleHidden, afterActions }: Props) {
  const p = pool.price;
  const free = wallet.balance.BRL + wallet.balance.USD * p;
  const invested = wallet.rende.BRL + wallet.rende.USD * p;
  const earned = wallet.earned.BRL + wallet.earned.USD * p;
  const dollars = dollarResult(wallet, p);
  // Escondido, mostra só a moeda: "R$ ••••".
  const show = (v: string) => (hidden ? `${v.split(/\s/)[0]} ••••` : v);

  return (
    <>
      <section className="balance-card">
        <div className="balance-top">
          <span className="hello">
            {greeting()}
            {name ? `, ${name}` : ""}
          </span>
          <button className="eye" onClick={onToggleHidden} aria-label={hidden ? "Mostrar saldo" : "Esconder saldo"} aria-pressed={hidden}>
            {hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        <span className="label">Seu patrimônio</span>
        <strong className="big">{show(reais(free + invested + earned))}</strong>
        <div className="balance-split">
          <span>Disponível {show(reais(free))}</span>
          <span>Na Rende {show(reais(invested))}</span>
        </div>
        {isDepositor(wallet) && (
          <div className="earned-chip">+ {show(reais(earned))} ganhos com o câmbio dos outros</div>
        )}
      </section>

      <div className="quick-actions" role="group" aria-label="Atalhos">
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
          Rende
        </button>
        <button onClick={onStatement}>
          <span className="qa-icon"><ListIcon /></span>
          Extrato
        </button>
        <button onClick={onDollars}>
          <span className="qa-icon qa-flag" aria-hidden>US$</span>
          Meus dólares
        </button>
        <button onClick={onAlert}>
          <span className="qa-icon"><BellIcon /></span>
          Alerta
        </button>
      </div>

      {afterActions}

      <section className="card">
        <h3>Suas moedas</h3>
        <ul className="list">
          <li>
            <span className="flag">🇧🇷</span>
            <span>Real</span>
            <strong>{show(money("BRL", wallet.balance.BRL))}</strong>
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
              <strong>{show(money("USD", wallet.balance.USD))}</strong>
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
            <button className="link small-link" onClick={onStatement} aria-label="Ver extrato completo">
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
