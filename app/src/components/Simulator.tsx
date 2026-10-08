import { Brand } from "./Brand";
import { useState } from "react";
import { project } from "../engine/projection";
import { pct, reais } from "../format";

const CDI = 0.1365;
const TBILL = 0.0386;

export function Simulator() {
  const [amount, setAmount] = useState(1000);
  const [giro, setGiro] = useState(0.05);
  const r = project({ poolBRL: 100e6, giro, cdi: CDI, tbill: TBILL });

  return (
    <section className="card">
      <h2>Simulador</h2>
      <p className="muted">
        Quanto mais câmbio passa pelo pool, mais quem deposita ganha. Mexa no movimento diário e veja.
      </p>

      <label>
        Quanto você deixaria na <Brand /> Rende (reais)
        <input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      </label>
      <label>
        Movimento diário do pool: <strong>{pct(giro)}</strong> do pool por dia
        <input type="range" min={0.01} max={0.1} step={0.005} value={giro} onChange={(e) => setGiro(Number(e.target.value))} />
      </label>

      <div className="stats">
        <div className="stat">
          <span className="muted">Conta comum (100% CDI), 1 ano</span>
          <strong>{reais(amount * CDI)}</strong>
        </div>
        <div className="stat highlight">
          <span className="muted"><Brand /> Rende, 1 ano</span>
          <strong>{reais(amount * r.rendeBRL)}</strong>
          <span>{pct(r.rendeBRL / CDI)} do CDI</span>
        </div>
        <div className="stat">
          <span className="muted">Dólar na Rende</span>
          <strong>{pct(r.rendeUSD)} a.a.</strong>
          <span>{(r.rendeUSD / TBILL).toFixed(1)}× o Tesouro americano</span>
        </div>
        <div className="stat">
          <span className="muted">Baleia (assume o risco)</span>
          <strong>{pct(r.baleia)} a.a.</strong>
        </div>
      </div>

      <p className="tip">
        💡 Premissas: pool de R$ 100 milhões, CDI {pct(CDI)}, Tesouro americano {pct(TBILL)}, 60% do volume vindo de apps
        parceiros. A <Brand /> só cobra 20% do que você ganhar <strong>acima</strong> de 100% do CDI. Valores antes de IR e
        IOF. Simulação, não promessa.
      </p>
    </section>
  );
}
