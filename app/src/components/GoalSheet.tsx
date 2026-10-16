import { Sheet } from "./Sheet";
import { ChevronIcon } from "./Icons";

export type Goal = "receber" | "viajar" | "guardar" | "pagar";

const GOALS: { id: Goal; title: string; detail: string; icon: string }[] = [
  { id: "receber", title: "Receber do exterior", detail: "Cliente lá fora paga em dólar digital; você troca para real", icon: "🌎" },
  { id: "viajar", title: "Viajar", detail: "Ter dólar antes da viagem, com a taxa aberta", icon: "✈️" },
  { id: "guardar", title: "Guardar em dólar", detail: "Comprar aos poucos e ver o preço médio", icon: "💵" },
  { id: "pagar", title: "Pagar com QR", detail: "Pagar um QR Pix com dólar, ou cobrar alguém", icon: "📱" },
];

const KEY = "cambi-goal-v1";

/** Já respondeu (ou dispensou) a pergunta de boas-vindas neste aparelho? */
export function goalAsked() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return true; // sem armazenamento: não insiste a cada abertura
  }
}

function remember(goal: Goal | "skip") {
  try {
    localStorage.setItem(KEY, goal);
  } catch {
    /* sem armazenamento */
  }
}

/** Primeira abertura: uma pergunta só, que leva direto à primeira ação certa para cada pessoa. */
export function GoalSheet({ onPick, onClose }: { onPick: (g: Goal) => void; onClose: () => void }) {
  const close = () => {
    remember("skip");
    onClose();
  };
  return (
    <Sheet title="O que você quer fazer primeiro?" onClose={close}>
      <ul className="list options">
        {GOALS.map((g) => (
          <li key={g.id}>
            <button
              className="row-btn"
              onClick={() => {
                remember(g.id);
                onPick(g.id);
              }}
            >
              <span className="qa-icon" aria-hidden>
                {g.icon}
              </span>
              <span>
                <strong>{g.title}</strong>
                <small className="muted">{g.detail}</small>
              </span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
      <button className="link" onClick={close}>
        Só quero explorar
      </button>
    </Sheet>
  );
}
