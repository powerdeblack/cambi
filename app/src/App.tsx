import { useState } from "react";
import { DepositPanel } from "./components/DepositPanel";
import { PoolDashboard } from "./components/PoolDashboard";
import { Simulator } from "./components/Simulator";
import { SwapPanel } from "./components/SwapPanel";
import { PoolState, createPool, deposit } from "./engine/pool";

const PRICE = 5.4; // cotação de demonstração; no programa on-chain vem do oráculo

function seedPool(): PoolState {
  let p = createPool(PRICE);
  p = deposit(p, "rende", "BRL", 540_000);
  p = deposit(p, "rende", "USD", 100_000);
  p = deposit(p, "baleia", "BRL", 54_000);
  p = deposit(p, "baleia", "USD", 10_000);
  return p;
}

type Tab = "trocar" | "pool" | "participar" | "simular";

const TABS: { id: Tab; label: string }[] = [
  { id: "trocar", label: "Trocar" },
  { id: "pool", label: "Pool ao vivo" },
  { id: "participar", label: "Participar" },
  { id: "simular", label: "Simular" },
];

export default function App() {
  const [pool, setPool] = useState<PoolState>(seedPool);
  const [tab, setTab] = useState<Tab>("trocar");

  return (
    <div className="app">
      <header>
        <img src="./logo.svg" alt="cambI" className="logo" />
        <p className="tagline">O câmbio sou eu.</p>
      </header>

      <nav>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === "trocar" && <SwapPanel pool={pool} onSwap={(r) => setPool(r.state)} />}
        {tab === "pool" && <PoolDashboard pool={pool} />}
        {tab === "participar" && <DepositPanel pool={pool} onChange={setPool} />}
        {tab === "simular" && <Simulator />}
      </main>

      <footer className="muted">
        Demonstração em ambiente de teste. Nenhum dinheiro real é movimentado. Em produção, entrada e saída via Pix são
        feitas por parceiro autorizado pelo Banco Central.
      </footer>
    </div>
  );
}
