import { Brand } from "./Brand";
import { useState } from "react";
import { PoolState, Side, SwapResult, UserKind, quote, swap } from "../engine/pool";
import { money, pct, reais } from "../format";

interface Props {
  pool: PoolState;
  onSwap: (r: SwapResult) => void;
}

const KIND_LABEL: Record<UserKind, string> = {
  depositor: "Sou depositante (0,5%)",
  retail: "Não sou depositante (1%)",
  b2b: "App parceiro B2B (0,4%)",
};

export function SwapPanel({ pool, onSwap }: Props) {
  const [side, setSide] = useState<Side>("BRL");
  const [amount, setAmount] = useState(500);
  const [kind, setKind] = useState<UserKind>("retail");
  const [last, setLast] = useState<SwapResult | null>(null);
  const [error, setError] = useState("");

  const out: Side = side === "BRL" ? "USD" : "BRL";
  const preview = amount > 0 ? quote(pool, side, amount, kind) : null;

  function doSwap() {
    try {
      const r = swap(pool, side, amount, kind);
      setLast(r);
      setError("");
      onSwap(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>Trocar</h2>
      <p className="muted">Cotação do oráculo: 1 dólar = {reais(pool.price)}</p>

      <div className="row">
        <label>
          Você envia
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </label>
        <button className="ghost" onClick={() => setSide(out)} aria-label="Inverter moedas">
          {side} ⇄ {out}
        </button>
      </div>

      <label>
        Quem é você?
        <select value={kind} onChange={(e) => setKind(e.target.value as UserKind)}>
          {(Object.keys(KIND_LABEL) as UserKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>

      {preview && (
        <p className="quote">
          Você recebe <strong>{money(out, preview.amountOut)}</strong> · taxa {pct(preview.feeRate)} (
          {money(side, preview.feeTotal)}), mostrada antes de confirmar.
        </p>
      )}

      <button className="primary" onClick={doSwap} disabled={!(amount > 0)}>
        Trocar agora
      </button>
      {error && <p className="error">{error}</p>}

      {last && <WhereDidMyMoneyGo r={last} />}
    </section>
  );
}

function WhereDidMyMoneyGo({ r }: { r: SwapResult }) {
  const c = r.feeCurrency;
  const parts = [
    { label: <>Quem deposita na <Brand /> Rende</>, value: r.toRende, cls: "rende" },
    { label: "Provedores de liquidez (Baleia)", value: r.toBaleia, cls: "baleia" },
    { label: "Parceiro regulado (Pix)", value: r.toPartner, cls: "partner" },
    { label: <><Brand /> (operação)</>, value: r.toPlatform, cls: "platform" },
  ];
  const inBRL = r.side === "BRL" ? r.amountIn : r.amountIn * r.state.price;
  const feeBRL = r.side === "BRL" ? r.feeTotal : r.feeTotal * r.state.price;

  return (
    <div className="explain">
      <h3>Para onde foi o seu dinheiro?</h3>
      <p>
        Você pagou <strong>{money(c, r.feeTotal)}</strong> de taxa. No banco, essa conta é invisível. Aqui está ela inteira:
      </p>
      <div className="bar" role="img" aria-label="Divisão da taxa">
        {parts.map((p) => (
          <span key={p.cls} className={p.cls} style={{ flexGrow: p.value }} />
        ))}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.cls}>
            <i className={p.cls} /> {p.label}: <strong>{money(c, p.value)}</strong>
          </li>
        ))}
      </ul>

      <h3>Quanto essa troca custaria em outro lugar?</h3>
      <ul className="compare">
        {r.comparison.map((b) => (
          <li key={b.name}>
            {b.name}: {reais(b.cost)} <span className="muted">(você economizou {reais(b.cost - feeBRL)})</span>
          </li>
        ))}
        <li>
          <strong><Brand />: {reais(feeBRL)}</strong> em uma troca de {reais(inBRL)}
        </li>
      </ul>
      <p className="tip">
        💡 <strong>Spread</strong> é a diferença entre o preço justo do dólar e o preço que cobram de você. Em casas de câmbio
        ele fica com a empresa. Na <Brand />, a maior parte volta para quem deposita.
      </p>
    </div>
  );
}
