import { useState } from "react";
import { rate } from "../format";
import { RateAlert, alertProblem } from "../history";
import { Sheet } from "./Sheet";

interface Props {
  price: number;
  alert: RateAlert | null;
  onSave: (a: RateAlert | null) => void;
  onClose: () => void;
}

/** "Me avise quando o dólar…": um alvo por vez, guardado no aparelho. */
export function AlertSheet({ price, alert, onSave, onClose }: Props) {
  const [dir, setDir] = useState<RateAlert["dir"]>(alert?.dir ?? "below");
  // Valor em décimos de milésimo (4 casas), digitado como nos apps de banco.
  const suggested = Math.round((dir === "below" ? price * 0.99 : price * 1.01) * 10_000);
  const [units, setUnits] = useState(alert ? Math.round(alert.target * 10_000) : suggested);
  const [touched, setTouched] = useState(Boolean(alert));
  const target = units / 10_000;
  const problem = alertProblem({ dir, target }, price);

  function pickDir(d: RateAlert["dir"]) {
    setDir(d);
    if (!touched) setUnits(Math.round((d === "below" ? price * 0.99 : price * 1.01) * 10_000));
  }

  function save() {
    onSave({ dir, target, createdAt: Date.now() });
    onClose();
    // Notificação do sistema, quando o navegador permite; senão o aviso aparece dentro do app.
    try {
      if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
    } catch {
      /* sem suporte */
    }
  }

  return (
    <Sheet title="Alerta de cotação" onClose={onClose}>
      <p className="muted">Dólar agora: <strong>{rate(price)}</strong>. Escolha quando quer ser avisado.</p>
      <div className="segmented" role="group" aria-label="Quando avisar">
        <button className={dir === "below" ? "on" : ""} aria-pressed={dir === "below"} onClick={() => pickDir("below")}>
          ▼ Cair para
        </button>
        <button className={dir === "above" ? "on" : ""} aria-pressed={dir === "above"} onClick={() => pickDir("above")}>
          ▲ Subir para
        </button>
      </div>
      <div className={`money-input alert-input${problem ? " invalid" : ""}`}>
        <label htmlFor="alert-target" className="label">Cotação alvo</label>
        <input
          id="alert-target"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={rate(target)}
          aria-invalid={Boolean(problem) || undefined}
          onChange={(e) => {
            setTouched(true);
            setUnits(Number(e.target.value.replace(/\D/g, "").slice(0, 6) || 0));
          }}
          onFocus={(e) => {
            const el = e.target;
            setTimeout(() => el.select(), 0);
          }}
        />
      </div>
      {problem ? <p className="error small">{problem}</p> : <p className="muted small">O aviso aparece enquanto o app estiver aberto (e como notificação, se você permitir).</p>}
      <button className="primary" disabled={Boolean(problem)} onClick={save}>
        {alert ? "Atualizar alerta" : "Criar alerta"}
      </button>
      {alert && (
        <button
          className="link"
          onClick={() => {
            onSave(null);
            onClose();
          }}
        >
          Remover alerta
        </button>
      )}
    </Sheet>
  );
}
