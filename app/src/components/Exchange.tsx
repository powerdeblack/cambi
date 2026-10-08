import { useState } from "react";
import { PoolState, Side, SwapResult, quote } from "../engine/pool";
import { money, pct, rate, reais } from "../format";
import { Wallet, isDepositor, kindFor } from "../wallet";
import { Brand } from "./Brand";
import { CheckIcon, SendIcon, SwapIcon } from "./Icons";
import { MoneyInput } from "./MoneyInput";

interface Props {
  pool: PoolState;
  wallet: Wallet;
  onSwap: (side: Side, amount: number) => SwapResult | Promise<SwapResult>;
  /** Modo blockchain: prévia exata do programa (taxa, valor recebido e motivo de recusa). */
  preview?: (side: Side, amount: number) => { amountOut: number; feeTotal: number; feeRate: number; blocker: string | null; price: number };
  onDone: () => void;
  /** Depois da troca, levar o valor recebido para fora (Pix ou conta em dólar). */
  onSendOut: (side: Side, amount: number) => void;
}

const FLAG: Record<Side, string> = { BRL: "🇧🇷 BRL", USD: "🇺🇸 USD" };

export function Exchange({ pool, wallet, onSwap, preview, onDone, onSendOut }: Props) {
  const [side, setSide] = useState<Side>("BRL");
  const [cents, setCents] = useState(50_000);
  const amount = cents / 100;
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<SwapResult | null>(null);
  const [busy, setBusy] = useState(false);

  const out: Side = side === "BRL" ? "USD" : "BRL";
  const over = amount > wallet.balance[side] + 1e-9;
  const pv = preview && amount > 0 && !over ? preview(side, amount) : null;
  const valid = amount > 0 && !over && !pv?.blocker;
  const q = pv ?? (valid ? quote(pool, side, amount, kindFor(wallet)) : null);
  const price = pv?.price ?? pool.price;

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      setReceipt(await onSwap(side, amount));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (receipt)
    return (
      <Receipt
        r={receipt}
        onClose={() => { setReceipt(null); onDone(); }}
        onSendOut={() => { setReceipt(null); onSendOut(receipt.side === "BRL" ? "USD" : "BRL", receipt.amountOut); }}
      />
    );

  return (
    <section className="card exchange">
      <h2>Trocar</h2>

      <div className="field-box">
        <MoneyInput side={side} cents={cents} onChange={setCents} label="Você envia" invalid={over} />
        <div className="field-foot">
          <span className={over ? "error" : "muted"}>
            {over ? "Saldo insuficiente · " : ""}Disponível: {money(side, wallet.balance[side])}
          </span>
          <button className="chip" onClick={() => setCents(Math.floor(wallet.balance[side] * 100))} disabled={wallet.balance[side] <= 0}>
            Tudo
          </button>
        </div>
      </div>

      <button className="flip" aria-label="Inverter moedas" onClick={() => { setSide(out); setCents(0); }}>
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
            <dt>Cotação{preview ? " do pool" : ""}</dt>
            <dd>1 US$ = {rate(price)}</dd>
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

      {pv?.blocker && <p className="error">{pv.blocker}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={!valid || busy} onClick={confirm}>
        {busy ? (
          <>
            <span className="spinner tiny" aria-hidden /> Confirmando na Solana…
          </>
        ) : (
          <>Trocar {valid ? money(side, amount) : ""}</>
        )}
      </button>
      {preview && !busy && <p className="muted small center">Troca real no programa da cambI na Solana (rede de testes).</p>}
    </section>
  );
}

function Receipt({ r, onClose, onSendOut }: { r: SwapResult; onClose: () => void; onSendOut: () => void }) {
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
      {r.signature && (
        <a className="chain-badge" href={`https://explorer.solana.com/tx/${encodeURIComponent(r.signature)}?cluster=devnet`} target="_blank" rel="noreferrer">
          <span className="live-dot" aria-hidden /> Registrada na Solana · ver transação ↗
        </a>
      )}
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
      <button className="primary" onClick={onSendOut}>
        <SendIcon /> {out === "BRL" ? `Enviar ${money(out, r.amountOut)} por Pix` : `Enviar ${money(out, r.amountOut)} para fora`}
      </button>
      <button className="secondary gap-top" onClick={onClose}>Deixar na carteira</button>
    </section>
  );
}
