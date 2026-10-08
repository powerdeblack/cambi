import { useState } from "react";
import { PoolState, Side, SwapResult, quote } from "../engine/pool";
import { money, pct, reais } from "../format";
import { Wallet, isDepositor, kindFor } from "../wallet";
import { Brand } from "./Brand";
import { CheckIcon, SwapIcon } from "./Icons";

interface Props {
  pool: PoolState;
  wallet: Wallet;
  onSwap: (side: Side, amount: number) => SwapResult;
  onDone: () => void;
}

const FLAG: Record<Side, string> = { BRL: "🇧🇷 BRL", USD: "🇺🇸 USD" };

export function Exchange({ pool, wallet, onSwap, onDone }: Props) {
  const [side, setSide] = useState<Side>("BRL");
  const [amount, setAmount] = useState(500);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<SwapResult | null>(null);

  const out: Side = side === "BRL" ? "USD" : "BRL";
  const valid = amount > 0;
  const q = valid ? quote(pool, side, amount, kindFor(wallet)) : null;

  function confirm() {
    try {
      setReceipt(onSwap(side, amount));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (receipt) return <Receipt r={receipt} onClose={() => { setReceipt(null); onDone(); }} />;

  return (
    <section className="card exchange">
      <h2>Trocar</h2>

      <div className="field-box">
        <span className="label">Você envia</span>
        <div className="amount-row">
          <input
            inputMode="decimal"
            type="number"
            min={0}
            value={amount}
            aria-label="Valor a enviar"
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <span className="currency">{FLAG[side]}</span>
        </div>
        <span className="muted">Disponível: {money(side, wallet.balance[side])}</span>
      </div>

      <button className="flip" aria-label="Inverter moedas" onClick={() => setSide(out)}>
        <SwapIcon />
      </button>

      <div className="field-box">
        <span className="label">Você recebe</span>
        <div className="amount-row">
          <strong className="amount-out">{q ? q.amountOut.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "0"}</strong>
          <span className="currency">{FLAG[out]}</span>
        </div>
      </div>

      {q && (
        <dl className="summary">
          <div>
            <dt>Cotação</dt>
            <dd>1 US$ = {reais(pool.price)}</dd>
          </div>
          <div>
            <dt>Taxa {isDepositor(wallet) ? "(depositante)" : ""}</dt>
            <dd>
              {money(side, q.feeTotal)} · {pct(q.feeRate)}
            </dd>
          </div>
        </dl>
      )}

      {!isDepositor(wallet) && (
        <p className="tip">Quem tem dinheiro na <Brand /> Rende paga metade: 0,5%.</p>
      )}

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!valid} onClick={confirm}>
        Trocar {valid ? money(side, amount) : ""}
      </button>
    </section>
  );
}

function Receipt({ r, onClose }: { r: SwapResult; onClose: () => void }) {
  const [details, setDetails] = useState(false);
  const c = r.feeCurrency;
  const out: Side = r.side === "BRL" ? "USD" : "BRL";
  const feeBRL = r.side === "BRL" ? r.feeTotal : r.feeTotal * r.state.price;
  const bank = r.comparison[0];
  const parts = [
    { label: <>Quem deposita na <Brand /> Rende</>, value: r.toRende, cls: "rende" },
    { label: "Provedores de liquidez (Baleia)", value: r.toBaleia, cls: "baleia" },
    { label: "Parceiro regulado (Pix)", value: r.toPartner, cls: "partner" },
    { label: <><Brand /> (operação)</>, value: r.toPlatform, cls: "platform" },
  ];

  return (
    <section className="card receipt">
      <div className="done-icon"><CheckIcon /></div>
      <h2>Troca concluída</h2>
      <p className="receipt-amount">
        {money(r.side, r.amountIn)} → <strong>{money(out, r.amountOut)}</strong>
      </p>

      <div className="saved-banner">
        Você economizou <strong>{reais(bank.cost - feeBRL)}</strong> em relação ao banco
      </div>

      <h3>Para onde foi a taxa de {money(c, r.feeTotal)}?</h3>
      <div className="bar" role="img" aria-label="Divisão da taxa">
        {parts.map((p) => (
          <span key={p.cls} className={p.cls} style={{ flexGrow: p.value }} />
        ))}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.cls}>
            <i className={p.cls} />
            <span>{p.label}</span>
            <strong>{money(c, p.value)}</strong>
          </li>
        ))}
      </ul>

      <button className="link" onClick={() => setDetails(!details)} aria-expanded={details}>
        {details ? "Ocultar comparação" : "Comparar com outros lugares"}
      </button>
      {details && (
        <ul className="list compare">
          {r.comparison.map((b) => (
            <li key={b.name}>
              <span>{b.name}</span>
              <strong>{reais(b.cost)}</strong>
            </li>
          ))}
          <li className="ours">
            <span><Brand /></span>
            <strong>{reais(feeBRL)}</strong>
          </li>
        </ul>
      )}

      <p className="tip">
        💡 <strong>Spread</strong> é a diferença entre o preço justo do dólar e o que cobram de você. No banco ele fica com o
        banco. Aqui, a maior parte volta para quem deposita.
      </p>
      <button className="primary" onClick={onClose}>Concluir</button>
    </section>
  );
}
