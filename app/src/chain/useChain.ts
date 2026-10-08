// Estado da conta na Solana devnet para as telas. O cliente (web3.js) só é baixado quando a pessoa ativa a conta.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainSigner, ChainState } from "./client";

type Client = typeof import("./client");
let clientPromise: Promise<Client> | null = null;
export const loadClient = () => (clientPromise ??= import("./client"));

export type ChainKind = "local" | "phantom";

export interface ChainActivity {
  id: number;
  kind: "swap" | "deposit" | "send" | "harvest" | "withdraw" | "faucet";
  side: "BRL" | "USD";
  amountIn: number;
  amountOut?: number;
  fee?: number;
  savedVsBank?: number;
  to?: string;
  route?: string;
  sig: string;
  at: number;
}

export type Chain =
  | { status: "off" }
  | { status: "connecting"; kind: ChainKind; step: string }
  | { status: "ready"; kind: ChainKind; owner: string; state: ChainState | null; activity: ChainActivity[] }
  | { status: "error"; kind: ChainKind; message: string };

const MODE_KEY = "cambi-chain-mode-v1";

/** Erros de rede e da carteira em linguagem de gente. */
export function humanize(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  if (/Failed to fetch|NetworkError|fetch failed|Load failed|ERR_/i.test(msg))
    return new Error("Sem conexão com a rede de testes da Solana agora. Confira a internet e tente de novo.");
  if (/429|Too many requests/i.test(msg)) return new Error("A rede de testes está ocupada. Tente de novo em alguns segundos.");
  if (/User rejected|rejected the request/i.test(msg)) return new Error("Você cancelou na carteira.");
  return e instanceof Error ? e : new Error(msg);
}
const activityKey = (owner: string) => `cambi-chain-activity-v1-${owner}`;

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignora */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignora */
    }
  },
};

const loadActivity = (owner: string): ChainActivity[] => {
  try {
    return JSON.parse(store.get(activityKey(owner)) ?? "[]");
  } catch {
    return [];
  }
};

export function useChain() {
  const [chain, setChain] = useState<Chain>({ status: "off" });
  const signer = useRef<ChainSigner | null>(null);

  const refresh = useCallback(async () => {
    const s = signer.current;
    if (!s) return null;
    const c = await loadClient();
    const state = await c.fetchState(s.publicKey);
    setChain((prev) => (prev.status === "ready" && prev.owner === s.publicKey.toBase58() ? { ...prev, state } : prev));
    return state;
  }, []);

  const activate = useCallback(async (kind: ChainKind, opts: { silent?: boolean } = {}) => {
    try {
      setChain({ status: "connecting", kind, step: kind === "phantom" ? "Conectando a Phantom…" : "Criando sua conta na Solana…" });
      const c = await loadClient();
      if (!c.isDeployed()) throw new Error("O programa ainda não está na devnet.");
      const s = kind === "phantom" ? await c.phantomSigner() : c.localSigner();
      signer.current = s;
      let state = await c.fetchState(s.publicKey);
      const owner = s.publicKey.toBase58();
      if (!state.hasTokenAccounts || (state.sol < 0.002 && state.balances[0] === 0n && state.balances[1] === 0n)) {
        setChain({ status: "connecting", kind, step: `Recebendo R$ ${c.FAUCET_BRL.toLocaleString("pt-BR")} de teste…` });
        const sig = await c.onboard(s.publicKey);
        const activity = [{ id: Date.now(), kind: "faucet" as const, side: "BRL" as const, amountIn: c.FAUCET_BRL, sig, at: Date.now() }, ...loadActivity(owner)];
        store.set(activityKey(owner), JSON.stringify(activity));
        state = await c.fetchState(s.publicKey);
      }
      store.set(MODE_KEY, kind);
      setChain({ status: "ready", kind, owner, state, activity: loadActivity(owner) });
    } catch (e) {
      signer.current = null;
      if (opts.silent) setChain({ status: "off" });
      else setChain({ status: "error", kind, message: humanize(e).message });
    }
  }, []);

  // Volta automaticamente para a conta usada da última vez.
  useEffect(() => {
    const mode = store.get(MODE_KEY) as ChainKind | null;
    if (mode === "local") activate("local", { silent: true });
    if (mode === "phantom") {
      loadClient().then((c) => {
        if (c.phantomProvider()) activate("phantom", { silent: true });
      });
    }
  }, [activate]);

  // Saldo e rendimento atualizados enquanto o app está aberto.
  useEffect(() => {
    if (chain.status !== "ready") return;
    const id = setInterval(() => refresh().catch(() => {}), 20_000);
    return () => clearInterval(id);
  }, [chain.status, refresh]);

  const deactivate = useCallback(() => {
    store.del(MODE_KEY);
    signer.current = null;
    setChain({ status: "off" });
  }, []);

  const record = useCallback((a: Omit<ChainActivity, "id" | "at">) => {
    const s = signer.current;
    if (!s) return;
    const owner = s.publicKey.toBase58();
    const activity = [{ ...a, id: Date.now(), at: Date.now() }, ...loadActivity(owner)].slice(0, 50);
    store.set(activityKey(owner), JSON.stringify(activity));
    setChain((prev) => (prev.status === "ready" ? { ...prev, activity } : prev));
  }, []);

  /** Executa uma operação na blockchain e atualiza saldos. */
  const run = useCallback(
    async <T,>(fn: (c: Client, s: ChainSigner, state: ChainState) => Promise<T>): Promise<T> => {
      const s = signer.current;
      if (!s) throw new Error("Ative sua conta na Solana primeiro.");
      try {
        const c = await loadClient();
        const state = await c.fetchState(s.publicKey);
        const out = await fn(c, s, state);
        await refresh().catch(() => {});
        return out;
      } catch (e) {
        throw humanize(e);
      }
    },
    [refresh],
  );

  return { chain, activate, deactivate, refresh, run, record };
}
