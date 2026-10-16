import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { Keypair } from "@solana/web3.js";
import { Side } from "../engine/pool";
import { isSanctioned, travelRuleApplies } from "../compliance";
import { money, rate } from "../format";
import { PixCharge, ScannedQr, SolanaPayRequest, amountForTarget, buildPix, buildSolanaPay, readQr } from "../payqr";
import { Wallet } from "../wallet";
import { FlowScreen } from "./FlowScreen";
import { CheckIcon, CopyIcon, QrIcon, ScanIcon, ShareIcon } from "./Icons";
import { MoneyInput } from "./MoneyInput";

export type PayRequest =
  | { kind: "pix"; amountBRL: number; payWith: Side; pix: PixCharge }
  | { kind: "solana"; amountUSD: number; payWith: Side; pay: SolanaPayRequest };

interface Props {
  mode: "pay" | "charge";
  wallet: Wallet;
  price: number; // reais por dólar (cotação do pool)
  live: boolean; // conta na Solana ativa
  owner?: string; // carteira da pessoa na Solana (para receber em USDC)
  usdMint: string; // dólar digital aceito (na devnet, o cUSD de teste da cambI)
  name?: string; // nome do cadastro, para a cobrança Pix
  /** Quanto sai do outro lado numa troca de `amount` (prévia, já com taxa). */
  preview: (side: Side, amount: number) => number;
  limitCheck: (side: Side, amount: number) => string | null;
  onPay: (p: PayRequest) => Promise<string[]> | string[];
  onClose: () => void;
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`;

/** QR Code desenhado em SVG (sem imagem externa nem HTML injetado: respeita a política de segurança do app). */
export function QrSvg({ text, label }: { text: string; label: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`-3 -3 ${n + 6} ${n + 6}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-3} y={-3} width={n + 6} height={n + 6} fill="#fff" />
      <path d={d} fill="#0b2545" />
    </svg>
  );
}

/** Câmera + leitor de QR do navegador (BarcodeDetector). Sem suporte, a pessoa cola o código. */
function Scanner({ onText }: { onText: (t: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number>();
  const [state, setState] = useState<"idle" | "on" | "unsupported" | "denied">("idle");

  const stop = () => {
    window.clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);

  async function start() {
    type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!BD || !navigator.mediaDevices?.getUserMedia) {
      setState("unsupported");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      const v = video.current!;
      v.srcObject = stream.current;
      await v.play();
      setState("on");
      const detector = new BD({ formats: ["qr_code"] });
      const tick = async () => {
        if (!stream.current) return;
        try {
          const found = await detector.detect(v);
          if (found[0]?.rawValue) {
            stop();
            setState("idle");
            onText(found[0].rawValue);
            return;
          }
        } catch {
          /* quadro ainda não pronto: tenta no próximo */
        }
        timer.current = window.setTimeout(tick, 250);
      };
      tick();
    } catch {
      stop();
      setState("denied");
    }
  }

  return (
    <div className="scanner">
      <video ref={video} className={state === "on" ? "on" : ""} muted playsInline aria-label="Câmera para ler o QR Code" />
      {state !== "on" && (
        <button className="secondary" onClick={start}>
          <ScanIcon /> Escanear com a câmera
        </button>
      )}
      {state === "on" && <p className="muted small">Aponte para o QR Code do Pix ou do Solana Pay…</p>}
      {state === "unsupported" && <p className="muted small">Este navegador não lê QR Code pela câmera. Cole o código abaixo.</p>}
      {state === "denied" && <p className="muted small">Sem acesso à câmera. Libere a permissão ou cole o código abaixo.</p>}
    </div>
  );
}

export function QrPay(props: Props) {
  const [mode, setMode] = useState(props.mode);
  return (
    <FlowScreen title={mode === "pay" ? "Pagar com QR Code" : "Cobrar com QR Code"} onClose={props.onClose}>
      <div className="chips tight" role="group" aria-label="O que fazer">
        <button className={`chip${mode === "pay" ? " on" : ""}`} aria-pressed={mode === "pay"} onClick={() => setMode("pay")}>
          <ScanIcon /> Pagar
        </button>
        <button className={`chip${mode === "charge" ? " on" : ""}`} aria-pressed={mode === "charge"} onClick={() => setMode("charge")}>
          <QrIcon /> Cobrar
        </button>
      </div>
      {mode === "pay" ? <PayPanel {...props} /> : <ChargePanel {...props} />}
    </FlowScreen>
  );
}

/* ---------- Pagar: lê Pix ou Solana Pay, escolhe com qual moeda pagar ---------- */

function PayPanel({ wallet, price, usdMint, preview, limitCheck, onPay, onClose, live, owner }: Props) {
  const [text, setText] = useState("");
  const [scanned, setScanned] = useState<ScannedQr | null>(null);
  const [error, setError] = useState("");
  const [cents, setCents] = useState(0);
  const [payWith, setPayWith] = useState<Side>("BRL");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ sigs: string[] } | null>(null);

  function read(raw: string) {
    try {
      const s = readQr(raw);
      setScanned(s);
      setError("");
      const amt = s.kind === "pix" ? s.pix.amount : s.pay.amount;
      setCents(amt ? Math.round(amt * 100) : 0);
      // Pix: quem vem de fora tende a pagar em dólar; Solana Pay: quem está no Brasil, em real.
      setPayWith(s.kind === "pix" ? (wallet.balance.USD > 0 ? "USD" : "BRL") : wallet.balance.USD > 0 ? "USD" : "BRL");
    } catch (e) {
      setScanned(null);
      setError((e as Error).message);
    }
  }

  if (done) {
    return (
      <section className="card receipt">
        <span className="ok-badge" aria-hidden>
          <CheckIcon />
        </span>
        <h3>Pagamento feito</h3>
        <p className="muted">
          {scanned?.kind === "pix" ? `${money("BRL", cents / 100)} pagos por Pix para ${scanned.pix.name || "o recebedor"}` : `${money("USD", cents / 100)} enviados por Solana Pay`}
        </p>
        {done.sigs.map((s, i) => (
          <a key={s} className="chain-badge" href={explorerTx(s)} target="_blank" rel="noreferrer">
            {done.sigs.length > 1 ? (i === 0 ? "Troca na Solana ↗" : "Pagamento na Solana ↗") : "Ver na Solana ↗"}
          </a>
        ))}
        {!live && <p className="muted small">Modo demonstração: saldo fictício, nada saiu de verdade.</p>}
        <button className="primary" onClick={onClose}>
          Concluir
        </button>
      </section>
    );
  }

  if (!scanned) {
    return (
      <section className="card form">
        <Scanner onText={read} />
        <label className="field">
          <span className="label">Ou cole o código (Pix copia e cola ou link Solana Pay)</span>
          <textarea className="paste" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="00020126… ou solana:…" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={!text.trim()} onClick={() => read(text)}>
          Continuar
        </button>
        <p className="muted small">Pague qualquer QR Pix com o seu dólar digital, ou um QR Solana Pay com os seus reais: a cambI converte no pool, na hora.</p>
      </section>
    );
  }

  const target = cents / 100;
  const outSide: Side = scanned.kind === "pix" ? "BRL" : "USD";
  let cost = target;
  let costError = "";
  if (payWith !== outSide && target > 0) {
    try {
      cost = amountForTarget(target, 100, preview(payWith, 100));
    } catch (e) {
      costError = (e as Error).message;
    }
  }
  const over = cost > wallet.balance[payWith] + 1e-9;
  const limit = target > 0 ? limitCheck(outSide, target) : null;
  let block = "";
  if (scanned.kind === "solana") {
    const p = scanned.pay;
    if (p.splToken && p.splToken !== usdMint) block = "Este QR pede um token diferente do dólar digital aceito aqui. Na devnet, só o dólar de teste da cambI.";
    else if (!p.splToken) block = "Este QR pede SOL, não dólar digital.";
    else if (isSanctioned(p.recipient)) block = "Carteira de destino bloqueada pela triagem de sanções.";
    else if (owner && p.recipient === owner) block = "Este QR é da sua própria conta.";
    else if (travelRuleApplies("usdc", target)) block = "A partir de US$ 1.000, use Enviar → Carteira, que pede os dados da Travel Rule.";
  }
  const ready = target > 0 && !over && !limit && !block && !costError && !busy;

  async function pay() {
    setBusy(true);
    setError("");
    try {
      const req: PayRequest =
        scanned!.kind === "pix"
          ? { kind: "pix", amountBRL: target, payWith, pix: scanned!.pix }
          : { kind: "solana", amountUSD: target, payWith, pay: scanned!.pay };
      setDone({ sigs: await onPay(req) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form qr-review">
      <p className="qr-kind">{scanned.kind === "pix" ? "QR Pix" : "QR Solana Pay"}</p>
      {scanned.kind === "pix" ? (
        <dl className="kv">
          <dt>Recebedor</dt>
          <dd>{scanned.pix.name || "—"}</dd>
          <dt>Cidade</dt>
          <dd>{scanned.pix.city || "—"}</dd>
          <dt>Chave Pix</dt>
          <dd>{scanned.pix.key.length > 12 ? `${scanned.pix.key.slice(0, 4)}•••${scanned.pix.key.slice(-4)}` : scanned.pix.key}</dd>
        </dl>
      ) : (
        <dl className="kv">
          <dt>Para</dt>
          <dd>{scanned.pay.label || "Carteira Solana"}</dd>
          <dt>Carteira</dt>
          <dd>{short(scanned.pay.recipient)}</dd>
          {scanned.pay.message && (
            <>
              <dt>Mensagem</dt>
              <dd>{scanned.pay.message}</dd>
            </>
          )}
        </dl>
      )}
      {(scanned.kind === "pix" ? scanned.pix.amount : scanned.pay.amount) ? (
        <p className="qr-amount">{money(outSide, target)}</p>
      ) : (
        <MoneyInput side={outSide} cents={cents} onChange={setCents} label="Valor a pagar" autoFocus />
      )}
      <div className="chips tight" role="group" aria-label="Pagar com">
        {(["BRL", "USD"] as Side[]).map((s) => (
          <button key={s} className={`chip${payWith === s ? " on" : ""}`} aria-pressed={payWith === s} onClick={() => setPayWith(s)}>
            {s === "BRL" ? "🇧🇷 Real" : "🇺🇸 Dólar digital"}
          </button>
        ))}
      </div>
      {target > 0 && (
        <p className="qr-cost">
          {payWith === outSide ? (
            <>
              Sai do seu saldo em {payWith === "BRL" ? "real" : "dólar"}: <strong>{money(payWith, cost)}</strong>
            </>
          ) : (
            <>
              Você paga <strong>{money(payWith, cost)}</strong>
              <span className="muted small">
                {" "}
                convertidos no pool a {rate(price)} (taxa inclusa) e entregues como {outSide === "BRL" ? "Pix" : "dólar digital"}
              </span>
            </>
          )}
        </p>
      )}
      <p className="muted small">Saldo: {money(payWith, wallet.balance[payWith])}</p>
      {over && <p className="error">Saldo insuficiente em {payWith === "BRL" ? "real" : "dólar"}.</p>}
      {limit && <p className="error">{limit}</p>}
      {block && <p className="error">{block}</p>}
      {costError && <p className="error">{costError}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={!ready} onClick={pay}>
        {busy ? (
          <>
            <span className="spinner tiny" aria-hidden /> {live ? "Confirmando na Solana…" : "Pagando…"}
          </>
        ) : (
          `Pagar ${target > 0 ? money(payWith, cost) : ""}`
        )}
      </button>
      <button className="link" onClick={() => setScanned(null)}>
        Ler outro código
      </button>
    </section>
  );
}

/* ---------- Cobrar: gera QR Pix (Brasil) ou Solana Pay (exterior) ---------- */

function ChargePanel({ live, owner, usdMint, name }: Props) {
  const [kind, setKind] = useState<"pix" | "solana">("pix");
  const [cents, setCents] = useState(0);
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const reference = useMemo(() => Keypair.generate().publicKey.toBase58(), []);
  const amount = cents / 100;
  const side: Side = kind === "pix" ? "BRL" : "USD";

  const code =
    kind === "pix"
      ? key.trim().length >= 4 && amount > 0
        ? buildPix({ key: key.trim(), name: name || "Cliente cambI", city: "SAO PAULO", amount, txid: `CAMBI${Date.now().toString(36).toUpperCase()}` })
        : ""
      : live && owner && amount > 0
        ? buildSolanaPay({ recipient: owner, amount, splToken: usdMint, reference, label: "cambI", message: name ? `Pagamento para ${name.split(" ")[0]}` : "Pagamento cambI" })
        : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* sem permissão de área de transferência */
    }
  }
  async function share() {
    try {
      await navigator.share?.({ title: "Cobrança cambI", text: code });
    } catch {
      /* compartilhamento cancelado */
    }
  }

  return (
    <section className="card form">
      <div className="chips tight" role="group" aria-label="Quem vai pagar">
        <button className={`chip${kind === "pix" ? " on" : ""}`} aria-pressed={kind === "pix"} onClick={() => setKind("pix")}>
          🇧🇷 Pix (Brasil)
        </button>
        <button className={`chip${kind === "solana" ? " on" : ""}`} aria-pressed={kind === "solana"} onClick={() => setKind("solana")}>
          🌎 Solana Pay (exterior)
        </button>
      </div>
      <MoneyInput side={side} cents={cents} onChange={setCents} label={kind === "pix" ? "Valor em reais" : "Valor em dólar"} />
      {kind === "pix" && (
        <label className="field">
          <span className="label">Sua chave Pix</span>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="E-mail, celular, CPF ou chave aleatória" autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
      )}
      {kind === "solana" && !(live && owner) && (
        <p className="warn-box">Para receber em dólar digital, crie sua conta na Solana na aba Início. Ela vira o endereço que recebe.</p>
      )}
      {code ? (
        <div className="qr-box">
          <QrSvg text={code} label={kind === "pix" ? "QR Code Pix" : "QR Code Solana Pay"} />
          <p className="qr-amount">{money(side, amount)}</p>
          <p className="muted small">
            {kind === "pix"
              ? "Qualquer app de banco paga este Pix. Quem estiver fora do Brasil pode pagar com dólar digital pela cambI."
              : "Quem paga escaneia com uma carteira Solana (como a Phantom). O dólar cai na sua conta cambI em segundos."}
          </p>
          <div className="row-actions">
            <button className="secondary" onClick={copy}>
              <CopyIcon /> {copied ? "Copiado!" : "Copiar código"}
            </button>
            {"share" in navigator && (
              <button className="secondary" onClick={share}>
                <ShareIcon /> Compartilhar
              </button>
            )}
          </div>
        </div>
      ) : kind === "solana" && !(live && owner) ? null : (
        <p className="muted small">{kind === "pix" ? "Digite o valor e a sua chave Pix para gerar o QR." : "Digite o valor para gerar o QR."}</p>
      )}
      <p className="muted small">
        {kind === "pix"
          ? "Na rede de testes, o Pix é simulado. Em produção, o QR vem do parceiro autorizado pelo Banco Central."
          : "Na devnet, o dólar digital é o cUSD de teste da cambI (sem valor real)."}
      </p>
    </section>
  );
}
