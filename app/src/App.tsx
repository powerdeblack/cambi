import { useState } from "react";
import { Exchange } from "./components/Exchange";
import { Home } from "./components/Home";
import { GrowIcon, HomeIcon, PoolIcon, SwapIcon } from "./components/Icons";
import { Logo } from "./components/Logo";
import { PoolDashboard } from "./components/PoolDashboard";
import { Rende } from "./components/Rende";
import { PoolState, Side, createPool, deposit } from "./engine/pool";
import { INITIAL_WALLET, Wallet, simulateMarket, walletDeposit, walletSwap } from "./wallet";

const PRICE = 5.4; // cotação de demonstração; no programa on-chain vem do oráculo

function seedPool(): PoolState {
  let p = createPool(PRICE);
  p = deposit(p, "rende", "BRL", 540_000);
  p = deposit(p, "rende", "USD", 100_000);
  p = deposit(p, "baleia", "BRL", 54_000);
  p = deposit(p, "baleia", "USD", 10_000);
  return p;
}

type Tab = "inicio" | "trocar" | "rende" | "pool";

const TABS: { id: Tab; label: string; Icon: () => JSX.Element }[] = [
  { id: "inicio", label: "Início", Icon: HomeIcon },
  { id: "trocar", label: "Trocar", Icon: SwapIcon },
  { id: "rende", label: "Rende", Icon: GrowIcon },
  { id: "pool", label: "Pool", Icon: PoolIcon },
];

export default function App() {
  const [pool, setPool] = useState<PoolState>(seedPool);
  const [wallet, setWallet] = useState<Wallet>(INITIAL_WALLET);
  const [tab, setTab] = useState<Tab>("inicio");

  function handleSwap(side: Side, amount: number) {
    const r = walletSwap(pool, wallet, side, amount);
    setPool(r.pool);
    setWallet(r.wallet);
    return r.result;
  }

  function handleDeposit(side: Side, amount: number) {
    const r = walletDeposit(pool, wallet, side, amount);
    setPool(r.pool);
    setWallet(r.wallet);
  }

  function handleMarket() {
    const r = simulateMarket(pool, wallet);
    setPool(r.pool);
    setWallet(r.wallet);
  }

  return (
    <div className="app">
      <header className="topbar">
        <Logo height={28} />
        <span className="demo-badge">Demo</span>
      </header>

      <main>
        {tab === "inicio" && <Home pool={pool} wallet={wallet} go={setTab} onSimulateMarket={handleMarket} />}
        {tab === "trocar" && <Exchange pool={pool} wallet={wallet} onSwap={handleSwap} onDone={() => setTab("inicio")} />}
        {tab === "rende" && <Rende wallet={wallet} onDeposit={handleDeposit} />}
        {tab === "pool" && <PoolDashboard pool={pool} />}
        <p className="footnote">
          Demonstração com saldo fictício. Nenhum dinheiro real é movimentado. Em produção, Pix via parceiro autorizado
          pelo Banco Central.
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
    </div>
  );
}
