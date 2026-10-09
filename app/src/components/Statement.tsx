import { useState } from "react";
import { ACTIVITY_ICON, CurrencyFilter, KindFilter, activityTitle, groupByDay, matches, monthSummary } from "../activity";
import { money, reais } from "../format";
import { Wallet } from "../wallet";
import { FlowScreen } from "./FlowScreen";

interface Props {
  wallet: Wallet;
  onClose: () => void;
}

const KINDS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "Tudo" },
  { id: "swap", label: "Trocas" },
  { id: "send", label: "Envios" },
  { id: "rende", label: "Rende" },
];
const CURRENCIES: { id: CurrencyFilter; label: string }[] = [
  { id: "all", label: "Todas as moedas" },
  { id: "BRL", label: "🇧🇷 Real" },
  { id: "USD", label: "🇺🇸 Dólar" },
];
const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "long" });

/** Extrato completo, com filtros e resumo do mês, como no app do banco. */
export function Statement({ wallet, onClose }: Props) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [currency, setCurrency] = useState<CurrencyFilter>("all");
  const items = wallet.activity.filter((a) => matches(a, kind, currency));
  const month = monthSummary(wallet.activity);

  return (
    <FlowScreen title="Extrato" onClose={onClose}>
      <section className="balance-card statement-summary">
        <span className="label">Em {monthFmt.format(Date.now())}</span>
        <strong className="big">{month.count} {month.count === 1 ? "movimentação" : "movimentações"}</strong>
        <div className="balance-split">
          {month.sent.BRL > 0 && <span>Enviado {reais(month.sent.BRL)}</span>}
          {month.sent.USD > 0 && <span>Enviado {money("USD", month.sent.USD)}</span>}
          {month.saved > 0 && <span>Economia vs. banco {reais(month.saved)}</span>}
        </div>
      </section>

      <div className="chips scroll" role="group" aria-label="Tipo de movimentação">
        {KINDS.map((k) => (
          <button key={k.id} className={`chip${kind === k.id ? " on" : ""}`} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="chips scroll" role="group" aria-label="Moeda">
        {CURRENCIES.map((c) => (
          <button key={c.id} className={`chip${currency === c.id ? " on" : ""}`} aria-pressed={currency === c.id} onClick={() => setCurrency(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="muted">Nenhuma movimentação com esses filtros.</p>
      ) : (
        groupByDay(items).map((g) => (
          <section key={g.label} className="statement-day">
            <h4>{g.label}</h4>
            <ul className="list activity card">
              {g.items.map((a) => {
                const out = a.side === "BRL" ? "USD" : "BRL";
                const negative = a.kind === "send";
                return (
                  <li key={a.id}>
                    <span className={`flag act-${a.kind}`}>{ACTIVITY_ICON[a.kind]}</span>
                    <span>
                      {activityTitle(a)}
                      <small className="muted">
                        {a.at ? timeFmt.format(a.at) : ""}
                        {a.kind === "send" && a.to ? ` · ${a.to}` : ""}
                        {a.kind === "swap" && a.amountOut !== undefined ? ` · recebeu ${money(out, a.amountOut)}` : ""}
                      </small>
                      {a.savedVsBank !== undefined && a.savedVsBank > 0 && <small className="saved">economizou {reais(a.savedVsBank)} vs. banco</small>}
                      {a.sig && (
                        <a className="chain-link" href={`https://explorer.solana.com/tx/${encodeURIComponent(a.sig)}?cluster=devnet`} target="_blank" rel="noreferrer">
                          ver na blockchain ↗
                        </a>
                      )}
                    </span>
                    <strong className={negative ? "neg" : undefined}>
                      {negative ? "− " : ""}
                      {money(a.side, a.amountIn)}
                    </strong>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </FlowScreen>
  );
}
