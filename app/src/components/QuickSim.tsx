import { useState } from "react";
import { BENCHMARKS, PoolState, Side, quote } from "../engine/pool";
import { money, pct } from "../format";
import { Wallet, kindFor } from "../wallet";
import { Brand } from "./Brand";
import { MoneyInput } from "./MoneyInput";

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

  const ours = amount > 0 ? quote(pool, side, amount, kindFor(wallet)) : null;
  const rows = [
    { name: "cambi", label: <Brand />, cost: ours?.feeRate ?? 0, receive: ours?.amountOut ?? 0 },
    ...BENCHMARKS.map((b) => ({ name: b.name, label: <>{b.name}</>, cost: b.rate, receive: convert(amount * (1 - b.rate)) })),
  ];
  const bank = rows[1].receive;
  const gain = (ours?.amountOut ?? 0) - bank;

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
      {amount > 0 && gain > 0 && (
        <p className="saved sim-gain">Você recebe {money(out, gain)} a mais que no banco.</p>
      )}
      <p className="muted small">Estimativa sem IOF, na cotação atual. Bancos e casas de câmbio: custo médio de mercado.</p>
      <button className="secondary" onClick={onSwap}>
        Trocar agora
      </button>
    </section>
  );
}
