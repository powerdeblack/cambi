import { Brand } from "./Brand";
import { useState } from "react";
import { PoolState, Side, Tranche, deposit } from "../engine/pool";
import { money } from "../format";

interface Props {
  pool: PoolState;
  onChange: (p: PoolState) => void;
}

export function DepositPanel({ pool, onChange }: Props) {
  const [tranche, setTranche] = useState<Tranche>("rende");
  const [side, setSide] = useState<Side>("BRL");
  const [amount, setAmount] = useState(10);

  return (
    <section className="card">
      <h2>Fazer parte do câmbio</h2>
      <div className="tranches">
        <button className={tranche === "rende" ? "tab active" : "tab"} onClick={() => setTranche("rende")}>
          🟢 <Brand /> Rende
        </button>
        <button className={tranche === "baleia" ? "tab active" : "tab"} onClick={() => setTranche("baleia")}>
          🐋 <Brand /> Baleia
        </button>
      </div>

      {tranche === "rende" ? (
        <p>
          Para qualquer pessoa. Quase todo o dinheiro fica aplicado em renda fixa (CDI no real, Tesouro americano no
          dólar), e você ainda recebe parte da taxa de cada troca. Perdas por desequilíbrio caem primeiro na Baleia.
          <strong> Comece com R$ 10.</strong>
        </p>
      ) : (
        <p>
          Para investidores qualificados. Seu dinheiro fica líquido e é o motor das trocas. Você assume o risco de
          desequilíbrio e, por isso, fica com a maior parte das taxas.
        </p>
      )}

      <div className="row">
        <label>
          Valor
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
        <label>
          Moeda
          <select value={side} onChange={(e) => setSide(e.target.value as Side)}>
            <option value="BRL">Real</option>
            <option value="USD">Dólar</option>
          </select>
        </label>
      </div>
      <button className="primary" disabled={!(amount > 0)} onClick={() => onChange(deposit(pool, tranche, side, amount))}>
        Depositar {money(side, amount || 0)}
      </button>

      <p className="warn">
        ⚠️ O dinheiro no pool <strong>não tem garantia do FGC</strong>, ao contrário de um CDB de banco. Rendimentos
        variam com o volume de trocas e não são garantidos.
      </p>
    </section>
  );
}
