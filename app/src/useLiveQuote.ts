import { useEffect, useState } from "react";
import { LiveQuote, fetchLiveQuote } from "./quote";

export type QuoteState =
  | { status: "loading" }
  | { status: "live"; quote: LiveQuote; checkedAt: number }
  | { status: "offline"; error: string };

const REFRESH_MS = 30_000;

/** Busca o dólar ao vivo ao abrir e a cada 30 s; avisa quem usa a cotação a cada atualização. */
export function useLiveQuote(onQuote: (q: LiveQuote) => void): QuoteState {
  const [state, setState] = useState<QuoteState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const quote = await fetchLiveQuote();
        if (!alive) return;
        onQuote(quote);
        setState({ status: "live", quote, checkedAt: Date.now() });
      } catch (e) {
        // Mantém a última cotação boa, se houver; só cai para "offline" se nunca conseguiu.
        if (alive) setState((s) => (s.status === "live" ? s : { status: "offline", error: (e as Error).message }));
      }
    }
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
