import { useEffect, useRef, useState } from "react";
import { Exchange } from "./components/Exchange";
import { Home } from "./components/Home";
import { BankIcon, ChevronIcon, GrowIcon, HomeIcon, KeyIcon, PoolIcon, SwapIcon } from "./components/Icons";
import { Logo } from "./components/Logo";
import { OnchainCard } from "./components/OnchainCard";
import { PoolDashboard } from "./components/PoolDashboard";
import { QuoteBadge } from "./components/QuoteBadge";
import { Rende } from "./components/Rende";
import { SendFlow } from "./components/SendFlow";
import { Sheet } from "./components/Sheet";
import { PoolState, Side, createPool, deposit, setPrice } from "./engine/pool";
import { money } from "./format";
import { useLiveQuote } from "./useLiveQuote";
import { INITIAL_WALLET, Recipient, Wallet, simulateMarket, walletDeposit, walletSend, walletSwap } from "./wallet";

const PRICE = 5.4; // cotação de referência, usada só até chegar a cotação ao vivo (ou se as fontes estiverem fora do ar)
const STORAGE_KEY = "cambi-demo-v1";

/** Pool de demonstração equilibrado em valor na cotação dada (mesmo valor em reais e em dólar). */
function seedPool(price = PRICE): PoolState {
  const usd = (brl: number) => Math.round(brl / price);
  let p = createPool(price);
  p = deposit(p, "rende", "BRL", 540_000);
  p = deposit(p, "rende", "USD", usd(540_000));
  p = deposit(p, "baleia", "BRL", 54_000);
  p = deposit(p, "baleia", "USD", usd(54_000));
  return p;
}

/** Carteira e pool salvos no aparelho, para a demo continuar de onde parou. */
function loadSaved(): { pool: PoolState; wallet: Wallet } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved?.pool?.liquid || !saved?.wallet?.balance) return null;
    return { pool: saved.pool, wallet: { ...INITIAL_WALLET, ...saved.wallet } };
  } catch {
    return null;
  }
}

type Tab = "inicio" | "trocar" | "rende" | "pool";
type Flow = { kind: "send"; side: Side; cents?: number } | null;

const TABS: { id: Tab; label: string; Icon: () => JSX.Element }[] = [
  { id: "inicio", label: "Início", Icon: HomeIcon },
  { id: "trocar", label: "Trocar", Icon: SwapIcon },
  { id: "rende", label: "Rende", Icon: GrowIcon },
  { id: "pool", label: "Pool", Icon: PoolIcon },
];

export default function App() {
  const [saved] = useState(loadSaved);
  const [pool, setPool] = useState<PoolState>(() => saved?.pool ?? seedPool());
  const [wallet, setWallet] = useState<Wallet>(() => saved?.wallet ?? INITIAL_WALLET);
  const [tab, setTab] = useState<Tab>("inicio");
  const [flow, setFlow] = useState<Flow>(null);
  const [chooser, setChooser] = useState(false);

  // Antes da primeira ação do usuário, o pool nasce equilibrado na cotação real; depois, só a cotação muda.
  const touched = useRef(saved !== null);
  const quote = useLiveQuote((q) => setPool((p) => (touched.current ? setPrice(p, q.price) : seedPool(q.price))));

  useEffect(() => {
    if (!touched.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pool, wallet }));
    } catch {
      /* navegação privada ou armazenamento bloqueado: a demo segue sem salvar */
    }
  }, [pool, wallet]);

  // Ao trocar de aba, volta ao topo, como num app nativo.
  useEffect(() => window.scrollTo({ top: 0 }), [tab]);

  function handleSwap(side: Side, amount: number) {
    touched.current = true;
    const r = walletSwap(pool, wallet, side, amount);
    setPool(r.pool);
    setWallet(r.wallet);
    return r.result;
  }

  function handleDeposit(side: Side, amount: number) {
    touched.current = true;
    const r = walletDeposit(pool, wallet, side, amount);
    setPool(r.pool);
    setWallet(r.wallet);
  }

  function handleMarket() {
    touched.current = true;
    const r = simulateMarket(pool, wallet);
    setPool(r.pool);
    setWallet(r.wallet);
  }

  function handleSend(side: Side, amount: number, fee: number, recipient: Recipient) {
    touched.current = true;
    setWallet((w) => walletSend(w, side, amount, fee, recipient));
  }

  function reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignora */
    }
    touched.current = false;
    setWallet(INITIAL_WALLET);
    setPool(seedPool(quote.status === "live" ? quote.quote.price : PRICE));
    setTab("inicio");
  }

  const openSend = (side: Side, cents?: number) => {
    setChooser(false);
    setFlow({ kind: "send", side, cents });
  };

  return (
    <div className="app">
      <header className="topbar">
        <Logo height={28} />
        <span className="demo-badge">Demo</span>
      </header>

      <main key={tab} className="screen">
        {(tab === "inicio" || tab === "trocar") && <QuoteBadge quote={quote} price={pool.price} />}
        {tab === "inicio" && (
          <Home pool={pool} wallet={wallet} go={setTab} onSend={() => setChooser(true)} onSimulateMarket={handleMarket} />
        )}
        {tab === "trocar" && (
          <Exchange
            pool={pool}
            wallet={wallet}
            onSwap={handleSwap}
            onDone={() => setTab("inicio")}
            onSendOut={(side, amount) => {
              setTab("inicio");
              openSend(side, Math.floor(amount * 100));
            }}
          />
        )}
        {tab === "rende" && <Rende wallet={wallet} onDeposit={handleDeposit} />}
        {tab === "pool" && (
          <>
            <OnchainCard />
            <PoolDashboard pool={pool} />
          </>
        )}
        <p className="footnote">
          Demonstração com saldo fictício. Nenhum dinheiro real é movimentado. Em produção, Pix via parceiro autorizado
          pelo Banco Central.{" "}
          {touched.current && (
            <button className="link inline" onClick={reset}>
              Recomeçar a demo
            </button>
          )}
        </p>
      </main>

      <nav className="bottom-nav" aria-label="Navegação principal">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {chooser && (
        <Sheet title="Enviar dinheiro" onClose={() => setChooser(false)}>
          <ul className="list options">
            <li>
              <button className="row-btn" onClick={() => openSend("BRL")}>
                <span className="qa-icon"><KeyIcon /></span>
                <span>
                  <strong>Pix em reais</strong>
                  <small className="muted">Para qualquer chave, na hora · saldo {money("BRL", wallet.balance.BRL)}</small>
                </span>
                <ChevronIcon />
              </button>
            </li>
            <li>
              <button className="row-btn" onClick={() => openSend("USD")}>
                <span className="qa-icon"><BankIcon /></span>
                <span>
                  <strong>Dólar para fora</strong>
                  <small className="muted">Conta nos EUA ou carteira USDC · saldo {money("USD", wallet.balance.USD)}</small>
                </span>
                <ChevronIcon />
              </button>
            </li>
          </ul>
        </Sheet>
      )}

      {flow?.kind === "send" && (
        <SendFlow
          key={`${flow.side}-${flow.cents ?? 0}`}
          side={flow.side}
          wallet={wallet}
          initialCents={flow.cents}
          onSend={handleSend}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
}
