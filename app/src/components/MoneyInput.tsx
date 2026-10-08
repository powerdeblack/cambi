import { useId } from "react";
import { Side } from "../engine/pool";
import { money } from "../format";

interface Props {
  side: Side;
  cents: number;
  onChange: (cents: number) => void;
  label: string;
  autoFocus?: boolean;
  invalid?: boolean;
}

/** Valor como nos apps de banco: você digita os números e os centavos se ajustam sozinhos (R$ 0,05 → R$ 0,50 → R$ 5,00). */
export function MoneyInput({ side, cents, onChange, label, autoFocus, invalid }: Props) {
  const id = useId();
  return (
    <div className={`money-input${invalid ? " invalid" : ""}`}>
      <label htmlFor={id} className="label">{label}</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        value={money(side, cents / 100)}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "").slice(0, 11) || 0))}
        // Ao tocar, seleciona o valor: o primeiro número digitado já começa um valor novo.
        onFocus={(e) => {
          const el = e.target;
          setTimeout(() => el.select(), 0);
        }}
      />
    </div>
  );
}
