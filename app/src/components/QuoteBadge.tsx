import { ago, rate } from "../format";
import { QuoteState } from "../useLiveQuote";

interface Props {
  quote: QuoteState;
  price: number; // cotação em uso no pool
}

/** Mostra de onde vem a cotação: ao vivo (com fonte e horário) ou de referência. */
export function QuoteBadge({ quote, price }: Props) {
  if (quote.status === "live") {
    return (
      <div className="quote-badge" role="status">
        <span className="live-dot" aria-hidden />
        <span>
          Dólar agora <strong>{rate(price)}</strong>
        </span>
        <span className="muted small">
          {quote.quote.source} · {ago(quote.quote.publishedAt)}
        </span>
      </div>
    );
  }
  return (
    <div className="quote-badge" role="status">
      <span className="ref-dot" aria-hidden />
      <span>
        Dólar <strong>{rate(price)}</strong>
      </span>
      <span className="muted small">{quote.status === "loading" ? "buscando cotação ao vivo…" : "cotação de referência"}</span>
    </div>
  );
}
