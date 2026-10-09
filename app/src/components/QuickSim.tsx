import { useState } from "react";
import { BENCHMARKS, PoolState, Side, quote } from "../engine/pool";
import { money, pct, pct2 } from "../format";
import { Wallet, kindFor } from "../wallet";
import { Brand } from "./Brand";
import { MoneyInput } from "./MoneyInput";
import { iofRate, withIof } from "../taxes";

interface Props {
  pool: PoolState;
  wallet: Wallet;
  onSwap: () => void;
}

/** Simulador rápido na tela inicial: quanto você recebe aqui e nos outros lugares, sem entrar na troca. */
export function QuickSim({ pool, wallet, onSwap }: Props) {
  const [side, setSide] = useState<Side>("BRL");
  const [cents, setCents] = useState(100_000);
  const amount = cents / 100;
  const out: Side = side === "BRL" ? "USD" : "BRL";
  const convert = (net: number) => (side === "BRL" ? net / pool.price : net * pool.price);

  const [withTax, setWithTax] = useState(true);
  // O IOF é igual em qualquer instituição; com ele ligado, todas as linhas mostram o valor final.
  const final = (fx: (forFx: number) => number) => (withTax ? withIof(side, amount, fx).receive : fx(amount));
  const iof = withTax && amount > 0 ? withIof(side, amount, (x) => x).iof * (side === "USD" ? pool.price : 1) : 0;
  const kind = kindFor(wallet);
  const ourFee = amount > 0 ? quote(pool, side, amount, kind).feeRate : 0;
  const rows = [
    { name: "cambi", label: <Brand />, cost: ourFee, receive: amount > 0 ? final((x) => quote(pool, side, x, kind).amountOut) : 0 },
    ...BENCHMARKS.map((b) => ({ name: b.name, label: <>{b.name}</>, cost: b.rate, receive: final((x) => convert(x * (1 - b.rate))) })),
  ];
  const bank = rows[1].receive;
  const gain = rows[0].receive - bank;

  return (
    <section className="card quick-sim" aria-label="Simulador de câmbio">
      <h3>Simule sua troca</h3>
      <div className="segmented small-seg" role="group" aria-label="Moeda que você tem">
        <button className={side === "BRL" ? "on" : ""} aria-pressed={side === "BRL"} onClick={() => setSide("BRL")}>
          🇧🇷 Tenho reais
        </button>
        <button className={side === "USD" ? "on" : ""} aria-pressed={side === "USD"} onClick={() => setSide("USD")}>
          🇺🇸 Tenho dólares
        </button>
      </div>
      <MoneyInput side={side} cents={cents} onChange={setCents} label={side === "BRL" ? "Quero trocar" : "Quero vender"} />
      <ul className="list sim-list">
        {rows.map((r, i) => (
          <li key={r.name} className={i === 0 ? "best" : undefined}>
            <span className="sim-dot" aria-hidden />
            <span>
              <span className="sim-name">{r.label}</span>
              <small className="muted">taxa {pct(r.cost)}</small>
            </span>
            <strong>{money(out, r.receive)}</strong>
          </li>
        ))}
      </ul>
      {amount > 0 && gain > 0.005 && (
        <p className="saved sim-gain">Você recebe {money(out, gain)} a mais que no banco.</p>
      )}
      <label className="toggle-row">
        <input type="checkbox" checked={withTax} onChange={(e) => setWithTax(e.target.checked)} />
        <span>
          Incluir IOF ({pct2(iofRate(side))}){withTax && amount > 0 ? ` · ${money("BRL", iof)}` : ""}
          <small className="muted">imposto do governo, igual em qualquer instituição</small>
        </span>
      </label>
      <p className="muted small">
        Na cotação atual. Bancos e casas de câmbio: custo médio de mercado. IOF de referência: {pct2(iofRate("BRL"))} na compra e {pct2(iofRate("USD"))} na venda de dólar; confirme a alíquota vigente.
      </p>
      <button className="secondary" onClick={onSwap}>
        Trocar agora
      </button>
    </section>
  );
}
