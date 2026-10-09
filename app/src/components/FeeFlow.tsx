import { useState } from "react";
import { BALEIA_SHARE_OF_LP, BASE_FEE, PARTNER_COST, PLATFORM_SHARE } from "../engine/pool";
import { feeSplitPer100 } from "../engine/growth";
import { reais } from "../format";
import { Brand } from "./Brand";

/** Para onde vai cada R$ 100 de taxa de uma troca de varejo (as mesmas regras do programa na Solana). */
export function FeeFlow() {
  const s = feeSplitPer100(1 - BALEIA_SHARE_OF_LP, PLATFORM_SHARE, PARTNER_COST / BASE_FEE.retail);
  const parts = [
    { id: "rende", label: <>Quem deposita na <Brand /> Rende</>, value: s.rende },
    { id: "baleia", label: "Provedores de liquidez (Baleia)", value: s.baleia },
    { id: "partner", label: "Parceiro regulado (Pix)", value: s.partner },
    { id: "platform", label: <><Brand /> (operação)</>, value: s.platform },
  ];
  const [hover, setHover] = useState<string | null>(null);
  const owners = s.rende + s.baleia;
  return (
    <section className="card">
      <h3>Para onde vai cada R$ 100 de taxa</h3>
      <p className="muted small">
        No banco, o spread fica com o banco. Aqui, <strong>{reais(owners)}</strong> de cada R$ 100 voltam para quem é dono do pool.
      </p>
      <div className="bar big-bar" role="img" aria-label={parts.map((p) => `${p.id} ${reais(p.value)}`).join(", ")}>
        {parts.map((p) => (
          <span
            key={p.id}
            className={`${p.id}${hover && hover !== p.id ? " dim" : ""}`}
            style={{ width: `${p.value}%` }}
            onPointerEnter={() => setHover(p.id)}
            onPointerLeave={() => setHover(null)}
            onPointerDown={() => setHover(p.id)}
          />
        ))}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.id} className={hover === p.id ? "on" : undefined} onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover(null)}>
            <i className={p.id} />
            <span>{p.label}</span>
            <strong>{reais(p.value)}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
