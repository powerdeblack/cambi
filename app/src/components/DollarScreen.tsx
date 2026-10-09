import { useState } from "react";
import { money, pct, rate, reais } from "../format";
import { Period, summary } from "../history";
import { dollarResult } from "../position";
import { QuoteState } from "../useLiveQuote";
import { Wallet } from "../wallet";
import { Brand } from "./Brand";
import { PeriodChips, useHistory } from "./DollarCard";
import { FlowScreen } from "./FlowScreen";
import { RateChart } from "./RateChart";

interface Props {
  wallet: Wallet;
  quote: QuoteState;
  price: number;
  onSwap: () => void;
  onRende: () => void;
  onClose: () => void;
}

const signed = (v: number) => `${v >= 0 ? "+" : "−"} ${reais(Math.abs(v))}`;

/** "Meus dólares": preço médio, o dólar de hoje no gráfico e o resultado com e sem o pool. */
export function DollarScreen({ wallet, quote, price, onSwap, onRende, onClose }: Props) {
  const [period, setPeriod] = useState<Period>(30);
  const [hover, setHover] = useState<number | null>(null);
  const { raw, points } = useHistory(period, quote, price);
  const r = dollarResult(wallet, price);
  const s = points ? summary(points) : null;
  const sel = hover !== null && points ? points[hover] : null;

  if (!r) {
    return (
      <FlowScreen title="Meus dólares" onClose={onClose} footer={<button className="primary" onClick={onSwap}>Comprar dólar</button>}>
        <section className="card hint">
          <p>Você ainda não comprou dólar. Na primeira troca, a <Brand /> passa a mostrar aqui o seu preço médio e quanto você ganha ou perde com o câmbio, com e sem o pool.</p>
        </section>
      </FlowScreen>
    );
  }

  const above = price >= r.avgPrice;
  const covered = r.fx < 0 && r.pool > 0 ? Math.min(1, r.pool / -r.fx) : null;

  return (
    <FlowScreen title="Meus dólares" onClose={onClose} footer={<button className="primary" onClick={onSwap}>Trocar</button>}>
      <section className="balance-card dollar-hero">
        <span className="label">Você tem</span>
        <strong className="big">{money("USD", r.usdOwned)}</strong>
        <div className="dollar-compare">
          <span>
            <small>Seu preço médio</small>
            <strong>{rate(r.avgPrice)}</strong>
          </span>
          <span>
            <small>{sel ? new Date(sel.t * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "Dólar agora"}</small>
            <strong>{rate(sel?.price ?? price)}</strong>
          </span>
        </div>
        <span className={`var-chip ${above ? "up" : "down"}`}>
          {above ? "▲" : "▼"} dólar {pct(Math.abs(r.fxPct))} {above ? "acima" : "abaixo"} do que você pagou
        </span>
      </section>

      <section className="card dollar-card">
        <div className="card-head">
          <h3>Dólar × seu preço médio</h3>
          <PeriodChips period={period} onChange={setPeriod} />
        </div>
        {points && s ? (
          <RateChart
            points={points}
            hover={hover}
            onHover={setHover}
            refPrice={r.avgPrice}
            refLabel="seu preço médio"
            label={`Dólar nos últimos ${period} dias, de ${rate(s.first)} para ${rate(s.last)}; seu preço médio é ${rate(r.avgPrice)}`}
          />
        ) : (
          <div className="chart chart-empty muted small">{raw === "error" ? "Histórico indisponível agora" : "Carregando histórico…"}</div>
        )}
        <p className="muted small chart-legend">
          <span className="legend-line green" /> dólar &nbsp; <span className="legend-line dashed" /> seu preço médio
        </p>
      </section>

      <section className="card">
        <h3>Se você vendesse tudo agora</h3>
        <ul className="list result-list">
          <li>
            <span>
              Câmbio
              <small className="muted">({rate(price)} − {rate(r.avgPrice)}) × {money("USD", r.usdOwned)}</small>
            </span>
            <strong className={r.fx >= 0 ? "pos" : "neg-red"}>{signed(r.fx)}</strong>
          </li>
          <li>
            <span>
              Ganhos com o pool
              <small className="muted">sua parte das taxas das trocas dos outros</small>
            </span>
            <strong className="pos">{signed(r.pool)}</strong>
          </li>
          <li className="total">
            <span>Resultado com o pool</span>
            <strong className={r.total >= 0 ? "pos" : "neg-red"}>{signed(r.total)}</strong>
          </li>
        </ul>
        <p className="muted small">
          {covered !== null
            ? `O dólar está abaixo do que você pagou, e o pool já compensou ${pct(covered)} dessa diferença.`
            : r.fx >= 0
              ? "O dólar está acima do que você pagou, e o pool soma ainda mais ao seu resultado."
              : "O dólar está abaixo do que você pagou. Deixando dólar na Rende, as taxas do pool ajudam a compensar."}
        </p>
      </section>

      {wallet.rende.USD <= 0 && (
        <section className="card hint">
          <p>Seus dólares estão parados na carteira. Na Rende, eles continuam seus e passam a ganhar com o câmbio dos outros.</p>
          <button className="secondary" onClick={onRende}>Deixar dólares na Rende</button>
        </section>
      )}

      <p className="muted small">
        Preço médio com a taxa incluída. Vendas e envios de dólar não mudam o preço médio do que ficou. IOF não incluído (é igual em qualquer instituição). Não é recomendação de investimento.
      </p>
    </FlowScreen>
  );
}
