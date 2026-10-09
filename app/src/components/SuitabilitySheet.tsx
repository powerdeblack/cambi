import { useState } from "react";
import { SUITABILITY_QUESTIONS, Suitability, suitabilityFrom } from "../compliance";
import { FlowScreen } from "./FlowScreen";

interface Props {
  onSave: (s: Suitability) => void;
  onClose: () => void;
}

const RESULT: Record<Suitability, string> = {
  conservador: "Conservador: prefere segurança. A Rende em reais combina com você; em dólar, há oscilação do câmbio.",
  moderado: "Moderado: aceita alguma oscilação em troca de ganhos maiores.",
  arrojado: "Arrojado: aceita oscilações maiores buscando ganhos maiores.",
};

/** Perfil de investidor (suitability, Res. CVM 30/2021): obrigatório antes do primeiro investimento. */
export function SuitabilitySheet({ onSave, onClose }: Props) {
  const [answers, setAnswers] = useState<(number | null)[]>(SUITABILITY_QUESTIONS.map(() => null));
  const [ack, setAck] = useState(false);
  const complete = answers.every((a) => a !== null);
  const result = complete ? suitabilityFrom(answers as number[]) : null;

  return (
    <FlowScreen
      title="Perfil de investidor"
      onClose={onClose}
      footer={
        <button className="primary" disabled={!complete || !ack} onClick={() => result && onSave(result)}>
          Salvar meu perfil
        </button>
      }
    >
      <p className="muted small">A lei pede que a gente conheça seu perfil antes de você investir. São 3 perguntas.</p>
      {SUITABILITY_QUESTIONS.map((q, qi) => (
        <fieldset key={q.id} className="card suit-q">
          <legend><strong>{q.q}</strong></legend>
          {q.a.map((a, ai) => (
            <label key={a} className="radio-row">
              <input
                type="radio"
                name={q.id}
                checked={answers[qi] === ai}
                onChange={() => setAnswers((x) => x.map((v, i) => (i === qi ? ai : v)))}
              />
              <span>{a}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {result && <p className="card hint">{RESULT[result]}</p>}
      <label className="toggle-row">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>Entendo que o dinheiro na Rende não tem garantia do FGC e que valores em dólar oscilam com o câmbio.</span>
      </label>
    </FlowScreen>
  );
}
