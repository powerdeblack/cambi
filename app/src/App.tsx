import { useEffect, useRef, useState } from "react";
import { previewSwap, fromUnits, toUnits } from "./chain/accounts";
import { useChain } from "./chain/useChain";
import { AlertSheet } from "./components/AlertSheet";
import { ChainCard } from "./components/ChainCard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DollarCard } from "./components/DollarCard";
import { DollarScreen } from "./components/DollarScreen";
import { Exchange } from "./components/Exchange";
import { Home } from "./components/Home";
import { BankIcon, ChevronIcon, GrowIcon, HomeIcon, KeyIcon, PoolIcon, SwapIcon, UserIcon } from "./components/Icons";
import { Logo } from "./components/Logo";
import { OnchainCard } from "./components/OnchainCard";
import { FeeFlow } from "./components/PoolDashboard";
import { PoolLive } from "./components/PoolLive";
import { QuoteBadge } from "./components/QuoteBadge";
import { QuickSim } from "./components/QuickSim";
import { Rende } from "./components/Rende";
import { SendFlow } from "./components/SendFlow";
import { Sheet } from "./components/Sheet";
import { Statement } from "./components/Statement";
import { BENCHMARKS, PoolState, Side, SwapResult, createPool, deposit, setPrice } from "./engine/pool";
import { money, rate } from "./format";
import { EMPTY_PROFILE, Profile, isVerified, limitProblem, loadProfile, saveProfile } from "./compliance";
import { Legal, LegalDoc } from "./components/Legal";
import { ProfileScreen } from "./components/ProfileScreen";
import { SuitabilitySheet } from "./components/SuitabilitySheet";
import { RateAlert, alertHit, loadAlert, saveAlert } from "./history";
import { useLiveQuote } from "./useLiveQuote";
import { INITIAL_WALLET, Recipient, Wallet, rememberRecipient, routeLabel, sanitizeWallet, simulateMarket, walletDeposit, walletSend, walletSwap } from "./wallet";

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
    return { pool: saved.pool, wallet: sanitizeWallet({ ...INITIAL_WALLET, ...saved.wallet }) };
  } catch {
    return null;
  }
}

const idx = (s: Side) => (s === "BRL" ? 0 : 1);

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
  const [statement, setStatement] = useState(false);
  const [dollarsOpen, setDollarsOpen] = useState(false);
  const [profile, setProfileState] = useState<Profile>(loadProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [suitabilityOpen, setSuitabilityOpen] = useState(false);
  const [legal, setLegal] = useState<LegalDoc | null>(null);
  // Esconder saldo (padrão dos apps de banco), lembrado neste aparelho.
  const [hideMoney, setHideMoney] = useState(() => {
    try {
      return localStorage.getItem("cambi-hide-v1") === "1";
    } catch {
      return false;
    }
  });
  const setProfile = (p: Profile) => {
    setProfileState(p);
    saveProfile(p);
  };
  const [alertOpen, setAlertOpen] = useState(false);
  const [alert, setAlert] = useState<RateAlert | null>(loadAlert);
  const [alertFired, setAlertFired] = useState<{ alert: RateAlert; price: number } | null>(null);

  // Antes da primeira ação do usuário, o pool nasce equilibrado na cotação real; depois, só a cotação muda.
  const touched = useRef(saved !== null);
  const quote = useLiveQuote((q) => setPool((p) => (touched.current ? setPrice(p, q.price) : seedPool(q.price))));

  // Conta na Solana (devnet): quando ativa, saldos e operações são reais na blockchain.
  const { chain, activate: activateChain, deactivate, run, record, claim } = useChain();
  // Criar a conta registra o aceite dos Termos e da Política de privacidade (LGPD).
  const activate: typeof activateChain = (kind, opts) => {
    setProfileState((p) => {
      if (p.termsAcceptedAt) return p;
      const next = { ...p, termsAcceptedAt: Date.now() };
      saveProfile(next);
      return next;
    });
    return activateChain(kind, opts);
  };
  const live = chain.status === "ready" && chain.state ? { ...chain, state: chain.state } : null;
  const chainPrice = live ? Number(live.state.pool.price) / 1e6 : null;
  const view: Wallet = live
    ? {
        balance: { BRL: fromUnits(live.state.balances[0]), USD: fromUnits(live.state.balances[1]) },
        rende: {
          BRL: fromUnits(live.state.positions.find((p) => p.side === 0)?.raw.amount ?? 0n),
          USD: fromUnits(live.state.positions.find((p) => p.side === 1)?.raw.amount ?? 0n),
        },
        earned: {
          BRL: fromUnits(live.state.positions.reduce((a, p) => a + p.pending[0], 0n)),
          USD: fromUnits(live.state.positions.reduce((a, p) => a + p.pending[1], 0n)),
        },
        activity: live.activity,
        recipients: wallet.recipients,
      }
    : wallet;
  const viewPool = chainPrice ? { ...pool, price: chainPrice } : pool;

  // Alerta de cotação: confere a cada cotação ao vivo; dispara uma vez e sai da lista.
  const livePrice = quote.status === "live" ? quote.quote.price : null;
  useEffect(() => {
    if (!alert || livePrice === null || !alertHit(alert, livePrice)) return;
    setAlertFired({ alert, price: livePrice });
    setAlert(null);
    saveAlert(null);
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("cambI · alerta de cotação", { body: `O dólar chegou a ${rate(livePrice)}.`, icon: "./icon-192.png" });
      }
    } catch {
      /* celulares sem notificação fora de service worker: fica o aviso dentro do app */
    }
  }, [alert, livePrice]);

  /** Limite por operação da conta, com o valor convertido para reais. */
  const limitCheck = (side: Side, amount: number) => limitProblem(profile, side === "BRL" ? amount : amount * viewPool.price);

  function updateAlert(a: RateAlert | null) {
    setAlert(a);
    saveAlert(a);
  }

  useEffect(() => {
    if (!touched.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pool, wallet }));
    } catch {
      /* navegação privada ou armazenamento bloqueado: a demo segue sem salvar */
    }
  }, [pool, wallet]);

  // Ao trocar de aba, volta ao topo, como num app nativo.
  // Chaves: no Chrome novo, scrollTo devolve uma Promise, e o React trataria isso como função de limpeza.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  async function chainSwap(side: Side, amount: number, purpose?: string): Promise<SwapResult> {
    // O mínimo aceito vem do valor que a pessoa viu na tela (prévia do mesmo estado exibido).
    const shown = previewSwap(live!.state, idx(side), toUnits(amount)).q.amountOut;
    const res = await run((c, s, st) => c.swap(s, st, idx(side), toUnits(amount), shown));
    const price = chainPrice ?? pool.price;
    const q = res.q;
    const feeTotal = fromUnits(q.fee);
    const inBRL = side === "BRL" ? amount : amount * price;
    const feeBRL = side === "BRL" ? feeTotal : feeTotal * price;
    const comparison = BENCHMARKS.map((b) => ({ name: b.name, cost: inBRL * b.rate }));
    const result: SwapResult = {
      side,
      amountIn: amount,
      amountOut: fromUnits(q.amountOut),
      feeRate: Number(q.feeBps) / 10_000,
      feeTotal,
      toRende: fromUnits(q.toRende),
      toBaleia: fromUnits(q.toBaleia),
      toPlatform: fromUnits(q.toPlatform),
      toPartner: fromUnits(q.toPartner),
      feeCurrency: side,
      comparison,
      state: { ...pool, price },
      signature: res.sig,
    };
    record({ kind: "swap", side, amountIn: amount, amountOut: result.amountOut, fee: feeTotal, savedVsBank: comparison[0].cost - feeBRL, purpose, sig: res.sig });
    return result;
  }

  function chainPreview(side: Side, amount: number) {
    const st = live!.state;
    const { q, blocker } = previewSwap(st, idx(side), toUnits(amount));
    return { amountOut: fromUnits(q.amountOut), feeTotal: fromUnits(q.fee), feeRate: Number(q.feeBps) / 10_000, blocker, price: chainPrice! };
  }

  async function chainDeposit(side: Side, amount: number) {
    const sig = await run((c, s) => c.depositRende(s, idx(side), toUnits(amount)));
    record({ kind: "deposit", side, amountIn: amount, sig });
  }

  async function chainHarvest() {
    const st = live!.state;
    const withFees = st.positions.filter((p) => p.pending[0] > 0n || p.pending[1] > 0n);
    if (withFees.length === 0) throw new Error("Ainda não há rendimento a receber. Ele chega a cada troca feita no pool.");
    for (const p of withFees) {
      const sig = await run((c, s) => c.withdrawRende(s, p.side, 0n));
      const brl = fromUnits(p.pending[0]) + fromUnits(p.pending[1]) * (chainPrice ?? pool.price);
      record({ kind: "harvest", side: "BRL", amountIn: brl, sig });
    }
  }

  async function chainWithdraw() {
    for (const p of live!.state.positions.filter((x) => x.raw.amount > 0n)) {
      const sig = await run((c, s) => c.withdrawRende(s, p.side, p.raw.amount));
      record({ kind: "withdraw", side: p.side === 0 ? "BRL" : "USD", amountIn: fromUnits(p.raw.amount), sig });
    }
  }

  async function chainSend(side: Side, amount: number, fee: number, recipient: Recipient) {
    // Na blockchain vai só um código de referência; chave Pix, nome e conta ficam fora dela.
    const reference = `${recipient.route}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const destination = recipient.route === "usdc" ? recipient.data.address ?? "" : "";
    const sig = await run((c, s) => c.sendOut(s, idx(side), toUnits(amount + fee), recipient.route, destination, reference));
    const route = routeLabel(recipient.route);
    record({ kind: "send", side, amountIn: amount, fee, to: `${recipient.name} · ${recipient.detail}`, route, sig });
    setWallet((w) => rememberRecipient(w, recipient));
    return sig;
  }

  function handleSwap(side: Side, amount: number, purpose?: string) {
    touched.current = true;
    const r = walletSwap(pool, wallet, side, amount, purpose);
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
    if (live) return chainSend(side, amount, fee, recipient);
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
        <div className="topbar-right">
          <span className="demo-badge">{live ? "Devnet" : "Demo"}</span>
          <button className="icon-btn profile-btn" onClick={() => setProfileOpen(true)} aria-label={isVerified(profile) ? "Perfil" : "Perfil: identidade não verificada"}>
            <UserIcon />
            {!isVerified(profile) && <span className="badge-dot" aria-hidden />}
          </button>
        </div>
      </header>

      <ErrorBoundary key={tab} onReset={() => setTab("inicio")}>
      <main className="screen">
        {alertFired && (
          <div className="alert-banner" role="alert">
            <span>
              <strong>O dólar chegou a {rate(alertFired.price)}</strong>
              <small>Seu alerta: {alertFired.alert.dir === "below" ? "abaixo de" : "acima de"} {rate(alertFired.alert.target)}</small>
            </span>
            <button
              className="chip on"
              onClick={() => {
                setAlertFired(null);
                setTab("trocar");
              }}
            >
              Trocar
            </button>
            <button className="icon-btn" aria-label="Fechar aviso" onClick={() => setAlertFired(null)}>
              ✕
            </button>
          </div>
        )}
        {tab === "trocar" && <QuoteBadge quote={quote} price={pool.price} />}
        {tab === "inicio" && (
          <Home
            pool={viewPool}
            wallet={view}
            go={setTab}
            onSend={() => setChooser(true)}
            onSimulateMarket={live ? undefined : handleMarket}
            onStatement={() => setStatement(true)}
            onDollars={() => setDollarsOpen(true)}
            onAlert={() => setAlertOpen(true)}
            name={profile.name.trim().split(/\s+/)[0] || undefined}
            hidden={hideMoney}
            onToggleHidden={() => {
              setHideMoney((h) => {
                try {
                  localStorage.setItem("cambi-hide-v1", h ? "0" : "1");
                } catch {
                  /* sem armazenamento */
                }
                return !h;
              });
            }}
            afterActions={
              <>
                <DollarCard quote={quote} price={pool.price} alert={alert} onAlert={() => setAlertOpen(true)} />
                <ChainCard
                  chain={chain}
                  balanceBRL={view.balance.BRL}
                  onActivate={activate}
                  onDeactivate={deactivate}
                  onLegal={setLegal}
                  onFaucet={async () => {
                    const sig = await claim();
                    record({ kind: "faucet", side: "BRL", amountIn: 1_000, sig });
                  }}
                />
              </>
            }
          />
        )}
        {tab === "inicio" && <QuickSim pool={viewPool} wallet={view} onSwap={() => setTab("trocar")} />}
        {tab === "trocar" && (
          <Exchange
            pool={viewPool}
            wallet={view}
            onSwap={live ? chainSwap : handleSwap}
            limitCheck={limitCheck}
            onVerify={() => setProfileOpen(true)}
            preview={live ? chainPreview : undefined}
            onDone={() => setTab("inicio")}
            onSendOut={(side, amount) => {
              setTab("inicio");
              openSend(side, Math.floor(amount * 100));
            }}
          />
        )}
        {tab === "rende" && (
          <Rende
            wallet={view}
            onDeposit={live ? chainDeposit : handleDeposit}
            suitability={profile.suitability?.profile}
            onSuitability={() => setSuitabilityOpen(true)}
            limitCheck={limitCheck}
            onchain={
              live
                ? {
                    onHarvest: chainHarvest,
                    onWithdraw: chainWithdraw,
                    unlockAt: Math.max(0, ...live.state.positions.filter((p) => p.raw.amount > 0n).map((p) => p.raw.lastDepositAt + live.state.pool.lockupSecs)),
                  }
                : undefined
            }
          />
        )}
        {tab === "pool" && (
          <>
            <PoolLive live={live} onRende={() => setTab("rende")} />
            <FeeFlow />
            <OnchainCard />
          </>
        )}
        <p className="footnote">
          {live
            ? "Conta na rede de testes da Solana: moedas de teste, sem valor real. "
            : "Demonstração com saldo fictício. Nenhum dinheiro real é movimentado. "}
          Em produção, Pix via parceiro autorizado pelo Banco Central.{" "}
          {touched.current && (
            <button className="link inline" onClick={reset}>
              Recomeçar a demo
            </button>
          )}
        </p>
      </main>
      </ErrorBoundary>

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
                  <small className="muted">Para qualquer chave, na hora · saldo {money("BRL", view.balance.BRL)}</small>
                </span>
                <ChevronIcon />
              </button>
            </li>
            <li>
              <button className="row-btn" onClick={() => openSend("USD")}>
                <span className="qa-icon"><BankIcon /></span>
                <span>
                  <strong>Dólar para fora</strong>
                  <small className="muted">Conta nos EUA ou carteira USDC · saldo {money("USD", view.balance.USD)}</small>
                </span>
                <ChevronIcon />
              </button>
            </li>
          </ul>
        </Sheet>
      )}

      {alertOpen && <AlertSheet price={livePrice ?? pool.price} alert={alert} onSave={updateAlert} onClose={() => setAlertOpen(false)} />}

      {statement && <Statement wallet={view} onClose={() => setStatement(false)} />}

      {profileOpen && (
        <ProfileScreen
          profile={profile}
          wallet={view}
          onSave={setProfile}
          onSuitability={() => setSuitabilityOpen(true)}
          onLegal={setLegal}
          onErase={() => {
            setProfile(EMPTY_PROFILE);
            saveProfile(null);
            updateAlert(null);
            reset();
            setProfileOpen(false);
          }}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {suitabilityOpen && (
        <SuitabilitySheet
          onSave={(s) => {
            setProfile({ ...profile, suitability: { profile: s, at: Date.now() } });
            setSuitabilityOpen(false);
          }}
          onClose={() => setSuitabilityOpen(false)}
        />
      )}

      {legal && <Legal doc={legal} onClose={() => setLegal(null)} />}

      {dollarsOpen && (
        <DollarScreen
          wallet={view}
          quote={quote}
          price={viewPool.price}
          onSwap={() => {
            setDollarsOpen(false);
            setTab("trocar");
          }}
          onRende={() => {
            setDollarsOpen(false);
            setTab("rende");
          }}
          onClose={() => setDollarsOpen(false)}
        />
      )}

      {flow?.kind === "send" && (
        <SendFlow
          key={`${flow.side}-${flow.cents ?? 0}`}
          side={flow.side}
          wallet={view}
          initialCents={flow.cents}
          onSend={handleSend}
          limitCheck={limitCheck}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
}
