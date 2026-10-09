import { useEffect, useState } from "react";
import deployment from "../devnet.json";
import { fromUnits } from "../chain/accounts";
import type { ChainState } from "../chain/client";
import type { ChainActivity } from "../chain/useChain";
import { money, pct, rate, reais } from "../format";
import { OnchainPool, fetchPool, fetchTokenBalance } from "../onchain";
import { DepositEvt, PoolEvt, SwapEvt, addMarks, earningsCurve, fetchPoolEvents, ownersCurve, ownersEarnedBRL } from "../poolEvents";
import { Brand } from "./Brand";
import { LineChart } from "./LineChart";

const REFRESH_MS = 30_000;
const d = deployment as unknown as { rpc: string; pool: string | null; brlVault: string | null; usdVault: string | null };

interface Live {
  owner: string;
  state: ChainState;
  activity: ChainActivity[];
}

type Data = { pool: OnchainPool; brl: number; usd: number; events: PoolEvt[]; readAt: number };

const whole = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const axis = (v: number) => v.toLocaleString("pt-BR", { notation: "compact", maximumFractionDigits: 2 });
const fine = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 });
const when = (at: number) =>
  new Date(at * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const day = (at: number) => new Date(at * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const tx = (sig: string) => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

function since(s: number, now: number) {
  const secs = Math.max(0, Math.round((now - s) / 1000));
  return secs < 60 ? `há ${secs}s` : `há ${Math.round(secs / 60)} min`;
}

/** Lê o pool real na Solana e atualiza sozinho a cada 30 s. */
function usePoolLive() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!d.pool || !d.brlVault || !d.usdVault) return;
    const [pool, brlVault, usdVault] = [d.pool, d.brlVault, d.usdVault];
    let alive = true;
    async function load() {
      try {
        const [p, brl, usd, events] = await Promise.all([
          fetchPool(d.rpc, pool),
          fetchTokenBalance(d.rpc, brlVault),
          fetchTokenBalance(d.rpc, usdVault),
          fetchPoolEvents(d.rpc, pool),
        ]);
        if (alive) {
          setData({ pool: p, brl, usd, events, readAt: Date.now() });
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { data, error };
}

/** Relógio para o "atualizado há Ns". */
function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

interface Props {
  live: Live | null;
  onRende: () => void;
}

/** Aba Pool com o dinheiro real: a sua posição e o rendimento ao vivo, o pool agora e as últimas trocas. */
export function PoolLive({ live, onRende }: Props) {
  const { data, error } = usePoolLive();
  const now = useNow();

  if (!d.pool) return null;
  if (!data) {
    return (
      <section className="card pool-loading" aria-busy={!error}>
        <div className="onchain-head">
          <span className="live-dot" aria-hidden />
          <h3>Pool ao vivo na Solana</h3>
        </div>
        <p className="muted">{error ? `Não foi possível ler a blockchain agora (${error}). Tentando de novo…` : "Lendo o pool na blockchain…"}</p>
        {!error && <div className="skeleton tall" />}
      </section>
    );
  }

  const status = (
    <span className="live-tag">
      <span className="live-dot" aria-hidden /> ao vivo · {since(data.readAt, now)}
    </span>
  );
  return (
    <>
      {live ? <MyPosition live={live} data={data} status={status} onRende={onRende} /> : <NoPosition onRende={onRende} />}
      <PoolNow data={data} owner={live?.owner} status={status} />
      <LastSwaps events={data.events} owner={live?.owner} />
    </>
  );
}

function MyPosition({ live, data, status, onRende }: { live: Live; data: Data; status: JSX.Element; onRende: () => void }) {
  const price = data.pool.price;
  const positions = live.state.positions.filter((p) => p.raw.amount > 0n || p.pending[0] > 0n || p.pending[1] > 0n);
  const brl = fromUnits(live.state.positions.find((p) => p.side === 0)?.raw.amount ?? 0n);
  const usd = fromUnits(live.state.positions.find((p) => p.side === 1)?.raw.amount ?? 0n);
  const pendingBRL = live.state.positions.reduce((s, p) => s + fromUnits(p.pending[0]) + fromUnits(p.pending[1]) * price, 0);
  const harvested = live.activity.filter((a) => a.kind === "harvest").reduce((s, a) => s + a.amountIn, 0);
  const earned = pendingBRL + harvested;
  const invested = brl + usd * price;

  if (positions.length === 0 && harvested === 0) return <NoPosition onRende={onRende} hasAccount />;

  const myDeposits = data.events.filter((e): e is DepositEvt => e.kind === "deposit" && e.user === live.owner);
  const localDeposits = live.activity.filter((a) => a.kind === "deposit").map((a) => Math.floor(a.at / 1000));
  const firstAt = Math.min(
    ...myDeposits.map((e) => e.at),
    ...localDeposits,
    ...live.state.positions.filter((p) => p.raw.amount > 0n).map((p) => p.raw.lastDepositAt),
  );
  const start = Number.isFinite(firstAt) ? firstAt : Math.floor(Date.now() / 1000);
  const marks = myDeposits.map((e) => ({
    at: e.at,
    label: `você depositou ${money(e.side === 0 ? "BRL" : "USD", e.amount)}`,
  }));
  if (marks.length === 0) marks.push({ at: start, label: "seu depósito" });
  const curve = earningsCurve(data.events, start, earned);
  // Ponto final "agora": a linha chega ao valor de hoje, que é o que a pessoa tem a receber.
  const nowAt = Math.floor(data.readAt / 1000);
  if (curve[curve.length - 1].at < nowAt) curve.push({ at: nowAt, value: earned, sig: "" });
  const { points, markers } = addMarks(curve, marks);

  const days = (Date.now() / 1000 - start) / 86400;
  const yearly = days >= 1 && invested > 0 ? Math.pow(1 + earned / invested, 365 / days) - 1 : null;

  return (
    <section className="balance-card pool-hero my-pool">
      <div className="hero-top">
        <span className="label">Seu dinheiro no pool</span>
        {status}
      </div>
      <strong className="big">{reais(invested)}</strong>
      <small className="hero-sub">
        {[brl > 0 && money("BRL", brl), usd > 0 && money("USD", usd)].filter(Boolean).join(" + ")} · desde {day(start)}
      </small>
      <div className="hero-tiles">
        <div>
          <small>Rendeu até agora</small>
          <strong>+ {fine(earned)}</strong>
          <small>{invested > 0 ? `${pct(earned / invested)} do valor` : "—"}</small>
        </div>
        <div>
          <small>A receber</small>
          <strong>{fine(pendingBRL)}</strong>
          <small>{harvested > 0 ? `já recebeu ${fine(harvested)}` : "cai a cada troca"}</small>
        </div>
        <div>
          <small>No ritmo atual</small>
          <strong>{yearly === null ? "—" : `${pct(yearly)}`}</strong>
          <small>{yearly === null ? "precisa de 1 dia" : "ao ano"}</small>
        </div>
      </div>
      <div className="hero-chart viz">
        <LineChart
          series={[{ id: "earned", label: "Seu rendimento", values: points.map((p) => p.value) }]}
          xLabel={(i) => (i === points.length - 1 ? "agora" : when(points[i].at))}
          format={fine}
          formatAxis={axis}
          markers={markers}
          height={170}
          label={`Seu rendimento real no pool: ${fine(earned)} desde ${day(start)}, ${markers.length} depósito(s) marcados.`}
        />
        <p className="chart-legend small">
          <span className="legend-line" aria-hidden /> rendimento acumulado
          <span className="legend-diamond" aria-hidden /> seus depósitos
        </p>
      </div>
      <p className="hero-note">
        Cada degrau é uma troca real que pagou taxa ao pool. O valor final é lido do programa na Solana; a divisão entre
        as trocas segue a parte da <Brand /> Rende de cada uma.
      </p>
      <button className="secondary on-dark" onClick={onRende}>
        Depositar mais ou receber
      </button>
    </section>
  );
}

function NoPosition({ onRende, hasAccount }: { onRende: () => void; hasAccount?: boolean }) {
  return (
    <section className="card pool-cta">
      <h3>Seu dinheiro trabalhando no pool</h3>
      <p className="muted">
        Quem deixa reais ou dólares na <Brand /> Rende vira dono do pool e recebe parte da taxa de cada troca. Depois do
        primeiro depósito, aqui aparece o seu rendimento real, ao vivo.
      </p>
      <button className="primary" onClick={onRende}>
        {hasAccount ? "Fazer o primeiro depósito" : "Criar conta e depositar"}
      </button>
    </section>
  );
}

function PoolNow({ data, owner, status }: { data: Data; owner?: string; status: JSX.Element }) {
  const { pool } = data;
  const total = data.brl + data.usd * pool.price;
  const paid = ownersEarnedBRL(data.events);
  const curve = ownersCurve(data.events);
  const mine = data.events.filter((e): e is SwapEvt => e.kind === "swap" && e.user === owner);
  const { points, markers } = addMarks(
    curve,
    mine.map((e) => ({
      at: e.at,
      label: e.sideIn === 0 ? `sua compra: ${money("USD", e.amountOut)} a ${rate(e.amountIn / e.amountOut)}` : `sua venda: ${money("USD", e.amountIn)}`,
    })),
  );
  const brlShare = total > 0 ? data.brl / total : 0.5;
  const swaps = curve.length;

  return (
    <section className="card viz pool-now">
      <div className="card-head">
        <h3>O pool agora</h3>
        {status}
      </div>
      <div className="stats">
        <div className="stat">
          <span className="muted">Valor nos cofres</span>
          <strong>{whole(total)}</strong>
        </div>
        <div className="stat">
          <span className="muted">Volume trocado</span>
          <strong>{whole(pool.volumeBRL)}</strong>
        </div>
        <div className="stat">
          <span className="muted">Trocas registradas</span>
          <strong>{pool.swapCount}</strong>
        </div>
        <div className="stat">
          <span className="muted">Cotação do oráculo</span>
          <strong>{rate(pool.price)}</strong>
        </div>
      </div>
      <div className="split" role="img" aria-label={`Real ${pct(brlShare)}, dólar ${pct(1 - brlShare)}`}>
        <span className="brl" style={{ width: `${brlShare * 100}%` }}>
          Real {pct(brlShare)}
        </span>
        <span className="usd" style={{ width: `${(1 - brlShare) * 100}%` }}>
          Dólar {pct(1 - brlShare)}
        </span>
      </div>

      <h4 className="sub-title">Pago aos donos do pool</h4>
      <p className="sim-headline">
        <strong>{fine(paid)}</strong> <span className="muted">nas últimas {swaps} trocas reais</span>
      </p>
      {points.length >= 2 ? (
        <>
          <LineChart
            series={[{ id: "owners", label: "Pago aos donos", values: points.map((p) => p.value) }]}
            xLabel={(i) => when(points[i].at)}
            format={fine}
            formatAxis={axis}
            markers={markers}
            height={170}
            label={`Total pago aos donos nas últimas ${swaps} trocas: ${fine(paid)}.`}
          />
          <p className="chart-legend small">
            <span className="legend-line" aria-hidden /> acumulado (Rende + Baleia)
            {markers.length > 0 && (
              <>
                <span className="legend-diamond" aria-hidden /> suas trocas
              </>
            )}
          </p>
        </>
      ) : (
        <p className="muted small">Ainda sem trocas suficientes para o gráfico.</p>
      )}
      <p className="muted small">
        Taxas acumuladas para os donos, ainda não sacadas: {reais(pool.lpFeesUnclaimed[0] + pool.lpFeesUnclaimed[1] * pool.price)}. Moedas de teste (cBRL e cUSD) na
        Solana devnet.
      </p>
    </section>
  );
}

function LastSwaps({ events, owner }: { events: PoolEvt[]; owner?: string }) {
  const swaps = events.filter((e): e is SwapEvt => e.kind === "swap").slice(-8).reverse();
  if (swaps.length === 0) return null;
  return (
    <section className="card">
      <h3>Últimas trocas reais</h3>
      <ul className="list swap-feed">
        {swaps.map((e) => {
          const buy = e.sideIn === 0;
          const toOwners = (e.toRende + e.toBaleia) * (buy ? 1 : e.price);
          return (
            <li key={e.sig + e.at}>
              <span className={`feed-icon ${buy ? "buy" : "sell"}`} aria-hidden>
                {buy ? "↑$" : "↓$"}
              </span>
              <span className="feed-main">
                <strong>
                  {buy ? "Compra" : "Venda"} de {money("USD", buy ? e.amountOut : e.amountIn)}
                  {e.user === owner && <em className="you"> · você</em>}
                </strong>
                <small className="muted">
                  {when(e.at)} · {short(e.user)} · a {rate(e.price)}
                </small>
              </span>
              <span className="feed-side">
                <b className="saved">+{fine(toOwners)}</b>
                <a href={tx(e.sig)} target="_blank" rel="noreferrer" className="muted small">
                  ver ↗
                </a>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Valor em verde: a parte da taxa de cada troca que foi para os donos do pool.</p>
    </section>
  );
}
