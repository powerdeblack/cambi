import { useEffect, useRef, useState } from "react";
import { Side } from "../engine/pool";
import { money } from "../format";
import {
  PIX_KEY_LABEL,
  PixKeyType,
  USD_ROUTE,
  UsdRoute,
  achError,
  maskPixKey,
  pixEndToEndId,
  pixKeyError,
  solanaAddressError,
} from "../payout";
import { Recipient, Wallet } from "../wallet";
import { FlowScreen } from "./FlowScreen";
import { BankIcon, CheckIcon, ChevronIcon, CopyIcon, KeyIcon, ShareIcon, ShieldIcon, WalletIcon } from "./Icons";
import { MoneyInput } from "./MoneyInput";
import { TRAVEL_RULE_USD, isSanctioned, travelRuleApplies } from "../compliance";

interface Props {
  side: Side; // BRL = Pix; USD = conta nos EUA ou carteira
  wallet: Wallet;
  initialCents?: number;
  /** Pode ser assíncrono (modo blockchain); devolve a assinatura da transação quando houver. */
  onSend: (side: Side, amount: number, fee: number, recipient: Recipient) => void | string | Promise<void | string>;
  onClose: () => void;
  /** Limite por operação da conta (null = dentro do limite). */
  limitCheck: (side: Side, amount: number) => string | null;
}

type Step = "destino" | "valor" | "revisar" | "enviando" | "pronto" | "erro";

const STAGES: Record<Recipient["route"], string[]> = {
  pix: ["Conferindo a chave Pix", "Enviando pelo parceiro autorizado", "Pix concluído"],
  ach: ["Conferindo a conta", "Enviando ao parceiro bancário nos EUA", "Transferência agendada"],
  usdc: ["Assinando a transação", "Confirmando na rede Solana", "Dólar na carteira"],
};

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function SendFlow({ side, wallet, initialCents, onSend, onClose, limitCheck }: Props) {
  const [step, setStep] = useState<Step>("destino");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [cents, setCents] = useState(initialCents ?? 0);
  const [stage, setStage] = useState(0);
  const [receipt, setReceipt] = useState<{ id: string; at: Date; sig?: string } | null>(null);
  const [failure, setFailure] = useState("");
  const [tick, setTick] = useState(0);
  // Resultado do envio: chega em paralelo à animação das etapas.
  const result = useRef<{ done: boolean; sig?: string; error?: string }>({ done: false });

  const route = recipient?.route ?? (side === "BRL" ? "pix" : "ach");
  const fee = route === "pix" ? 0 : USD_ROUTE[route].fee;
  const amount = cents / 100;
  const balance = wallet.balance[side];
  const over = amount + fee > balance + 1e-9;
  const limit = amount > 0 && !over ? limitCheck(side, amount) : null;
  // Envio para carteira: triagem de sanções e, a partir de US$ 1.000, a Travel Rule (dados de quem recebe).
  const sanctioned = route === "usdc" && isSanctioned(recipient?.data.address ?? "");
  const travel = travelRuleApplies(route, amount);
  const [ownWallet, setOwnWallet] = useState<boolean | null>(null);
  const [beneficiary, setBeneficiary] = useState("");
  const travelOk = !travel || ownWallet === true || (ownWallet === false && beneficiary.trim().split(/\s+/).length >= 2);

  // Começa o envio uma única vez ao entrar na etapa "enviando".
  useEffect(() => {
    if (step !== "enviando" || !recipient) return;
    result.current = { done: false };
    Promise.resolve()
      .then(() => onSend(side, amount, fee, recipient))
      .then((sig) => (result.current = { done: true, sig: sig || undefined }))
      .catch((e: Error) => (result.current = { done: true, error: e.message }));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Etapas visíveis; a última só aparece quando o envio confirma de verdade.
  useEffect(() => {
    if (step !== "enviando" || !recipient) return;
    const delay = reduceMotion() ? 150 : 750;
    const last = STAGES[route].length - 1;
    const t = setTimeout(() => {
      const r = result.current;
      if (r.done && r.error) {
        setFailure(r.error);
        setStep("erro");
      } else if (stage < last - 1) {
        setStage((x) => x + 1);
      } else if (r.done && stage === last - 1) {
        setStage(last);
      } else if (r.done && stage === last) {
        setReceipt({ id: route === "pix" ? pixEndToEndId() : r.sig ?? fakeTxId(route), at: new Date(), sig: r.sig });
        navigator.vibrate?.(30);
        setStep("pronto");
      } else {
        setStage((x) => x); // ainda confirmando: confere de novo
        setTick((n) => n + 1);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [step, stage, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  if (step === "destino") {
    return (
      <FlowScreen title={side === "BRL" ? "Para quem?" : "Para onde?"} step={1} steps={3} onClose={onClose}>
        <Destination
          side={side}
          recents={wallet.recipients.filter((r) => r.side === side)}
          onPick={(r) => {
            setRecipient(r);
            // Valor sugerido (ex.: o que veio da troca) nunca passa do saldo, já descontada a tarifa do destino.
            const routeFee = r.route === "pix" ? 0 : USD_ROUTE[r.route].fee;
            setCents((c) => Math.min(c, Math.max(0, Math.floor((balance - routeFee) * 100 + 1e-6))));
            setStep("valor");
          }}
        />
      </FlowScreen>
    );
  }

  if (step === "valor" && recipient) {
    const presets = [0.25, 0.5, 1].map((f) => ({
      label: f === 1 ? "Tudo" : `${f * 100}%`,
      cents: Math.max(0, Math.floor((balance - fee) * f * 100 + 1e-6)),
    }));
    return (
      <FlowScreen
        title="Quanto?"
        focusTitle={false}
        step={2}
        steps={3}
        onBack={() => setStep("destino")}
        onClose={onClose}
        footer={
          <button className="primary" disabled={cents === 0 || over || Boolean(limit)} onClick={() => setStep("revisar")}>
            Continuar
          </button>
        }
      >
        <RecipientChip r={recipient} />
        <MoneyInput side={side} cents={cents} onChange={setCents} label="Valor a enviar" autoFocus invalid={over} />
        <p className={over ? "error" : "muted"}>
          {over
            ? `Saldo insuficiente${fee ? " (inclui a tarifa)" : ""}. Disponível: ${money(side, balance)}`
            : `Disponível: ${money(side, balance)}`}
        </p>
        {limit && <p className="warn-box">{limit}</p>}
        <div className="chips">
          {presets.map((p) => (
            <button key={p.label} className="chip" onClick={() => setCents(p.cents)} disabled={p.cents === 0}>
              {p.label}
            </button>
          ))}
        </div>
        {balance === 0 && (
          <p className="tip">
            Você ainda não tem {side === "BRL" ? "reais" : "dólares"}. Faça uma troca primeiro e volte aqui.
          </p>
        )}
      </FlowScreen>
    );
  }

  if (step === "revisar" && recipient) {
    return (
      <FlowScreen
        title="Confira o envio"
        step={3}
        steps={3}
        onBack={() => setStep("valor")}
        onClose={onClose}
        footer={
          <button className="primary" disabled={sanctioned || !travelOk} onClick={() => { setStage(0); setStep("enviando"); }}>
            Confirmar e enviar {money(side, amount)}
          </button>
        }
      >
        <div className="review-amount">
          <span className="label">Você envia</span>
          <strong>{money(side, amount)}</strong>
        </div>
        <RecipientChip r={recipient} />
        <dl className="summary boxed">
          <div><dt>Quem recebe</dt><dd>{money(side, amount)}</dd></div>
          <div><dt>Tarifa</dt><dd>{fee ? money(side, fee) : "Grátis"}</dd></div>
          <div><dt>Sai da sua conta</dt><dd>{money(side, amount + fee)}</dd></div>
          <div><dt>Chega</dt><dd>{route === "pix" ? "na hora, 24h" : USD_ROUTE[route].eta}</dd></div>
          <div><dt>Por meio de</dt><dd>{route === "pix" ? "Pix (parceiro autorizado)" : USD_ROUTE[route].via}</dd></div>
        </dl>
        {sanctioned && (
          <p className="warn-box" role="alert">
            Não é possível enviar para este endereço: ele consta em lista de sanções. Por lei, a operação é bloqueada.
          </p>
        )}
        {travel && !sanctioned && (
          <fieldset className="card travel-rule">
            <legend><strong>Dados de quem recebe</strong></legend>
            <p className="muted small">
              Envios de cripto a partir de {money("USD", TRAVEL_RULE_USD)} levam os dados de quem envia e de quem recebe (Travel Rule, regra internacional do GAFI).
            </p>
            <div className="segmented small-seg">
              <button type="button" className={ownWallet === true ? "on" : ""} aria-pressed={ownWallet === true} onClick={() => setOwnWallet(true)}>
                A carteira é minha
              </button>
              <button type="button" className={ownWallet === false ? "on" : ""} aria-pressed={ownWallet === false} onClick={() => setOwnWallet(false)}>
                É de outra pessoa
              </button>
            </div>
            {ownWallet === false && (
              <label className="field">
                <span className="label">Nome completo de quem recebe</span>
                <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} autoComplete="off" />
              </label>
            )}
          </fieldset>
        )}
        <p className="secure"><ShieldIcon /> Confira os dados. Depois de enviado, o valor não pode ser cancelado.</p>
      </FlowScreen>
    );
  }

  if (step === "enviando" && recipient) {
    const stages = STAGES[route];
    return (
      <FlowScreen title="Enviando…" onClose={() => {}}>
        <div className="processing" aria-live="polite">
          <div className="spinner" aria-hidden />
          <ol className="stages">
            {stages.map((s, i) => (
              <li key={s} className={i < stage ? "done" : i === stage ? "now" : ""}>
                <span className="dot">{i < stage ? <CheckIcon /> : null}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
      </FlowScreen>
    );
  }

  if (step === "erro") {
    return (
      <FlowScreen
        title="Não foi enviado"
        onClose={onClose}
        footer={<button className="primary" onClick={() => setStep("revisar")}>Tentar de novo</button>}
      >
        <div className="processing">
          <p className="error" role="alert">{failure}</p>
          <p className="muted center">Nenhum valor saiu da sua conta.</p>
        </div>
      </FlowScreen>
    );
  }

  if (step === "pronto" && recipient && receipt) {
    return (
      <FlowScreen
        title="Comprovante"
        onClose={onClose}
        footer={<button className="primary" onClick={onClose}>Concluir</button>}
      >
        <SendReceipt side={side} amount={amount} fee={fee} recipient={recipient} id={receipt.id} at={receipt.at} sig={receipt.sig} />
      </FlowScreen>
    );
  }

  return null;
}

function fakeTxId(route: Recipient["route"]) {
  const chars = route === "usdc" ? "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz" : "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < (route === "usdc" ? 64 : 16); i++) s += chars[Math.floor(Math.random() * chars.length)];
  return route === "ach" ? `ACH-${s}` : s;
}

function RecipientChip({ r }: { r: Recipient }) {
  return (
    <div className="recipient-chip">
      <span className="avatar" aria-hidden>{initials(r.name)}</span>
      <span>
        <strong>{r.name}</strong>
        <small className="muted">{r.detail}</small>
      </span>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

/* ---------- Passo 1: destino ---------- */

function Destination({ side, recents, onPick }: { side: Side; recents: Recipient[]; onPick: (r: Recipient) => void }) {
  const [usdRoute, setUsdRoute] = useState<UsdRoute>("ach");
  return (
    <>
      {recents.length > 0 && (
        <section>
          <span className="label">Recentes</span>
          <ul className="list recents">
            {recents.map((r) => (
              <li key={r.id}>
                <button className="row-btn" onClick={() => onPick(r)}>
                  <span className="avatar" aria-hidden>{initials(r.name)}</span>
                  <span>
                    <strong>{r.name}</strong>
                    <small className="muted">{r.detail}</small>
                  </span>
                  <ChevronIcon />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {side === "BRL" ? (
        <PixForm onPick={onPick} />
      ) : (
        <>
          <div className="segmented" role="tablist" aria-label="Tipo de destino">
            {(["ach", "usdc"] as const).map((k) => (
              <button key={k} role="tab" aria-selected={usdRoute === k} className={usdRoute === k ? "on" : ""} onClick={() => setUsdRoute(k)}>
                {k === "ach" ? <BankIcon /> : <WalletIcon />} {k === "ach" ? "Conta nos EUA" : "Carteira USDC"}
              </button>
            ))}
          </div>
          {usdRoute === "ach" ? <AchForm onPick={onPick} /> : <UsdcForm onPick={onPick} />}
        </>
      )}
    </>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  hint?: string;
}) {
  const [touched, setTouched] = useState(false);
  const show = touched && props.error;
  return (
    <label className={`field${show ? " invalid" : ""}`}>
      <span className="label">{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={show ? true : undefined}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={() => setTouched(true)}
      />
      {show ? <small className="error">{props.error}</small> : props.hint ? <small className="muted">{props.hint}</small> : null}
    </label>
  );
}

const PIX_PLACEHOLDER: Record<PixKeyType, string> = {
  cpf: "000.000.000-00",
  celular: "(11) 98765-4321",
  email: "nome@email.com",
  aleatoria: "123e4567-e89b-12d3-a456-426614174000",
};
const PIX_INPUT: Record<PixKeyType, "numeric" | "tel" | "email" | "text"> = {
  cpf: "numeric",
  celular: "tel",
  email: "email",
  aleatoria: "text",
};

function PixForm({ onPick }: { onPick: (r: Recipient) => void }) {
  const [type, setType] = useState<PixKeyType>("celular");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const error = pixKeyError(type, key);
  return (
    <section className="form">
      <span className="label">Nova chave Pix</span>
      <div className="chips" role="radiogroup" aria-label="Tipo de chave">
        {(Object.keys(PIX_KEY_LABEL) as PixKeyType[]).map((t) => (
          <button key={t} role="radio" aria-checked={type === t} className={`chip${type === t ? " on" : ""}`} onClick={() => { setType(t); setKey(""); }}>
            {PIX_KEY_LABEL[t]}
          </button>
        ))}
      </div>
      <Field label={PIX_KEY_LABEL[type]} value={key} onChange={setKey} error={error} placeholder={PIX_PLACEHOLDER[type]} inputMode={PIX_INPUT[type]} />
      <Field label="Nome do contato (opcional)" value={name} onChange={setName} placeholder="Ex.: Maria" hint="No app real, o nome vem da consulta oficial da chave." />
      <button
        className="primary"
        disabled={!!error}
        onClick={() =>
          onPick({
            id: `pix:${type}:${key.trim()}`,
            side: "BRL",
            route: "pix",
            name: name.trim() || `Chave ${PIX_KEY_LABEL[type].toLowerCase()}`,
            detail: `Pix · ${maskPixKey(type, key)}`,
            data: { type, key: key.trim() },
          })
        }
      >
        <KeyIcon /> Continuar com esta chave
      </button>
    </section>
  );
}

function AchForm({ onPick }: { onPick: (r: Recipient) => void }) {
  const [holder, setHolder] = useState("");
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [kind, setKind] = useState<"checking" | "savings">("checking");
  const error = achError(holder, routing, account);
  return (
    <section className="form">
      <Field label="Nome do titular" value={holder} onChange={setHolder} placeholder="Como está no banco" error={holder.trim().length < 3 ? "Informe o nome do titular" : null} />
      <Field label="Routing number (ABA)" value={routing} onChange={setRouting} placeholder="9 dígitos" inputMode="numeric" error={error?.startsWith("Routing") ? error : null} hint="Fica no app do banco ou no rodapé do cheque." />
      <Field label="Número da conta" value={account} onChange={setAccount} placeholder="Só números" inputMode="numeric" error={error?.startsWith("Número") ? error : null} />
      <div className="segmented small-seg" role="radiogroup" aria-label="Tipo de conta">
        {(["checking", "savings"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {k === "checking" ? "Corrente (checking)" : "Poupança (savings)"}
          </button>
        ))}
      </div>
      <p className="muted small">Tarifa do parceiro bancário: {money("USD", USD_ROUTE.ach.fee)} · chega em {USD_ROUTE.ach.eta}.</p>
      <button
        className="primary"
        disabled={!!error}
        onClick={() =>
          onPick({
            id: `ach:${routing.trim()}:${account.trim()}`,
            side: "USD",
            route: "ach",
            name: holder.trim(),
            detail: `${kind === "checking" ? "Checking" : "Savings"} ••••${account.trim().slice(-4)} · ACH`,
            data: { holder: holder.trim(), routing: routing.trim(), account: account.trim(), kind },
          })
        }
      >
        <BankIcon /> Continuar com esta conta
      </button>
    </section>
  );
}

function UsdcForm({ onPick }: { onPick: (r: Recipient) => void }) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const error = solanaAddressError(address);
  const a = address.trim();
  return (
    <section className="form">
      <Field label="Endereço da carteira (Solana)" value={address} onChange={setAddress} placeholder="Ex.: 7xKX…9fQa" error={error} />
      <Field label="Nome do contato (opcional)" value={name} onChange={setName} placeholder="Ex.: Minha Phantom" />
      <p className="warn-box">Envie só para carteiras na <strong>rede Solana</strong>. Em outra rede, o dólar se perde.</p>
      <p className="muted small">Sem tarifa · chega em segundos.</p>
      <button
        className="primary"
        disabled={!!error}
        onClick={() =>
          onPick({
            id: `usdc:${a}`,
            side: "USD",
            route: "usdc",
            name: name.trim() || "Carteira USDC",
            detail: `${a.slice(0, 4)}…${a.slice(-4)} · Solana`,
            data: { address: a },
          })
        }
      >
        <WalletIcon /> Continuar com esta carteira
      </button>
    </section>
  );
}

/* ---------- Comprovante ---------- */

function SendReceipt(props: { side: Side; amount: number; fee: number; recipient: Recipient; id: string; at: Date; sig?: string }) {
  const { side, amount, fee, recipient, id, at, sig } = props;
  const [copied, setCopied] = useState(false);
  const route = recipient.route;
  const when = at.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const title = route === "pix" ? "Pix enviado" : route === "ach" ? "Transferência enviada" : "Dólar enviado";
  const idLabel = route === "pix" ? "ID da transação (fim a fim)" : route === "ach" ? "Protocolo" : "Assinatura da transação";
  const text = [
    `cambI · ${title}`,
    `Valor: ${money(side, amount)}`,
    `Para: ${recipient.name} (${recipient.detail})`,
    `Data: ${when}`,
    `${idLabel}: ${id}`,
    "Comprovante de demonstração, sem valor real.",
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* sem permissão de área de transferência: ignora */
    }
  }

  async function share() {
    try {
      if (navigator.share) await navigator.share({ title, text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      /* usuário cancelou */
    }
  }

  return (
    <div className="send-receipt">
      <div className="done-icon pop"><CheckIcon /></div>
      <p className="muted center">{title}</p>
      <strong className="receipt-big">{money(side, amount)}</strong>
      <p className="muted center">{when}</p>
      {sig && (
        <a className="chain-badge" href={`https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`} target="_blank" rel="noreferrer">
          <span className="live-dot" aria-hidden /> Registrado na Solana · ver transação ↗
        </a>
      )}

      <dl className="summary boxed">
        <div><dt>Para</dt><dd>{recipient.name}</dd></div>
        <div><dt>{route === "pix" ? "Chave" : "Destino"}</dt><dd>{recipient.detail}</dd></div>
        <div><dt>Tarifa</dt><dd>{fee ? money(side, fee) : "Grátis"}</dd></div>
        <div><dt>Instituição</dt><dd>{route === "pix" ? "Parceiro autorizado (demo)" : route === "ach" ? "Parceiro bancário nos EUA (demo)" : "Rede Solana (demo)"}</dd></div>
        <div className="stack">
          <dt>{idLabel}</dt>
          <dd className="mono">{id}</dd>
        </div>
      </dl>

      <div className="actions-row">
        <button className="secondary" onClick={copy}><CopyIcon /> {copied ? "Copiado!" : "Copiar ID"}</button>
        <button className="secondary" onClick={share}><ShareIcon /> Compartilhar</button>
      </div>
      <p className="muted small center">
        {sig
          ? route === "usdc"
            ? "As moedas de teste saíram da sua conta e chegaram na carteira de destino, na Solana (rede de testes)."
            : "As moedas de teste saíram da sua conta na Solana para o parceiro, com o destino registrado na transação. O pagamento do outro lado é simulado."
          : "Demonstração: nenhum dinheiro real foi enviado."}{" "}
        Em produção, o Pix sai por um parceiro autorizado pelo Banco Central e o dólar por parceiro bancário nos EUA ou
        direto na sua carteira.
      </p>
    </div>
  );
}
