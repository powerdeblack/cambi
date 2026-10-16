// Métricas do pool v2 (devnet), a partir da blockchain: eventos do programa e transações recusadas.
//
// Recusas: só as que chegaram à rede. O app e os scripts simulam antes de enviar, então a maioria das recusas
// (disjuntor, limites de KYC) não vira transação; para medir essas, o app precisa contar (sem dado pessoal).
//
// Publica SÓ agregados em deployments/metrics-v2.json (nenhum endereço de carteira): o repositório é público e,
// pela LGPD, endereço é dado pseudônimo. Contagem de carteiras é feita em memória e descartada.
//
// Uso (GitHub Actions): npx tsx scripts/metrics-v2.ts
import { BorshCoder, EventParser, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "fs";
import idlJson from "../idl/cambi_pool_v2.json";

const DEPLOYMENT = "deployments/devnet-v2.json";
const OUT = "deployments/metrics-v2.json";
const MAX_TX = Number(process.env.METRICS_MAX_TX ?? 1500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function slowFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 400 - Date.now();
    lastCall = Math.max(Date.now(), lastCall + 400);
    if (wait > 0) await sleep(wait);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 20) return res;
    await sleep(Math.min(2_000 * attempt, 20_000));
  }
}

// Nomes de erro do programa a partir do IDL (para contar recusas por motivo).
const ERRORS: Record<number, string> = Object.fromEntries(((idlJson as Idl).errors ?? []).map((e) => [e.code, e.name]));

async function main() {
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const connection = new Connection(dep.rpc, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: slowFetch as typeof fetch });
  const programId = new PublicKey(dep.programId);
  const idl = { ...(idlJson as Idl), address: dep.programId };
  const parser = new EventParser(programId, new BorshCoder(idl));
  const pool = new PublicKey(dep.pool);

  // Assinaturas do pool, da mais nova para a mais antiga.
  const sigs: { signature: string; err: unknown; blockTime?: number | null }[] = [];
  for (let before: string | undefined; sigs.length < MAX_TX; ) {
    const page = await connection.getSignaturesForAddress(pool, { before, limit: 1000 }, "confirmed");
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86_400;
  const m = {
    swaps: 0,
    volumeBRL: 0,
    volume7dBRL: 0,
    fees: { total: 0, rende: 0, baleia: 0, platform: 0, partner: 0 },
    deposits: 0,
    withdrawals: 0,
    queueRequests: 0,
    queueClaims: 0,
    credentials: { issued: 0, revoked: 0, frozen: 0 },
    pauses: 0,
    rejects: {} as Record<string, number>,
    daily: {} as Record<string, { swaps: number; volumeBRL: number }>,
  };
  const active7d = new Set<string>(); // só em memória; nunca gravado
  const active30d = new Set<string>();
  const brl = (side: number, amount: number, p: number) => (side === 0 ? amount : amount * p);

  for (const s of sigs) {
    const at = s.blockTime ?? now;
    const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const logs = tx.meta?.logMessages ?? [];
    if (tx.meta?.err) {
      const code = Number(logs.join("\n").match(/Error Number: (\d+)/)?.[1] ?? NaN);
      const name = ERRORS[code] ?? (Number.isNaN(code) ? "outro" : `erro ${code}`);
      m.rejects[name] = (m.rejects[name] ?? 0) + 1;
      continue;
    }
    for (const ev of parser.parseLogs(logs)) {
      // O EventParser pode devolver os campos em snake_case (como no IDL) ou camelCase: aceita os dois.
      const raw = ev.data as Record<string, any>;
      const d = new Proxy(raw, { get: (o, k: string) => o[k] ?? o[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())] });
      const num = (v: any) => Number(v?.toString?.() ?? v) / 1e6;
      switch (ev.name) {
        case "SwapEvent": {
          const p = Number(d.price.toString()) / 1e6;
          const v = brl(d.sideIn, num(d.amountIn), p);
          m.swaps++;
          m.volumeBRL += v;
          const feeBrl = (x: any) => brl(d.sideIn, num(x), p);
          m.fees.total += feeBrl(d.fee);
          m.fees.rende += feeBrl(d.toRende);
          m.fees.baleia += feeBrl(d.toBaleia);
          m.fees.platform += feeBrl(d.toPlatform);
          m.fees.partner += feeBrl(d.toPartner);
          const day = new Date(at * 1000).toISOString().slice(0, 10);
          m.daily[day] ??= { swaps: 0, volumeBRL: 0 };
          m.daily[day].swaps++;
          m.daily[day].volumeBRL += v;
          if (now - at <= 7 * DAY) {
            m.volume7dBRL += v;
            active7d.add(d.user.toBase58());
          }
          if (now - at <= 30 * DAY) active30d.add(d.user.toBase58());
          break;
        }
        case "DepositEvent":
          m.deposits++;
          break;
        case "WithdrawEvent":
          if (d.tranche === 255) m.queueClaims++;
          else m.withdrawals++;
          break;
        case "WithdrawRequestedEvent":
          m.queueRequests++;
          break;
        case "CredentialEvent":
          if (d.revoked) m.credentials.revoked++;
          else m.credentials.issued++;
          break;
        case "FreezeEvent":
          if (d.frozen) m.credentials.frozen++;
          break;
        case "PauseEvent":
          if (d.paused) m.pauses++;
          break;
      }
    }
  }

  const round = (x: number) => Math.round(x * 100) / 100;
  const out = {
    updatedAt: new Date().toISOString(),
    program: dep.programId,
    pool: dep.pool,
    transactionsRead: sigs.length,
    northStar: { activeWallets7d: active7d.size, activeWallets30d: active30d.size },
    swaps: m.swaps,
    volumeBRL: round(m.volumeBRL),
    volume7dBRL: round(m.volume7dBRL),
    feesBRL: Object.fromEntries(Object.entries(m.fees).map(([k, v]) => [k, round(v)])),
    rende: { deposits: m.deposits, withdrawals: m.withdrawals, queueRequests: m.queueRequests, queueClaims: m.queueClaims },
    compliance: { credentialsIssued: m.credentials.issued, credentialsRevoked: m.credentials.revoked, freezes: m.credentials.frozen },
    safety: { pauses: m.pauses, rejectsByReason: m.rejects },
    daily: Object.entries(m.daily)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, swaps: v.swaps, volumeBRL: round(v.volumeBRL) })),
    note: "Rede de testes: moedas sem valor real. Só agregados; nenhum endereço de carteira é publicado.",
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  writeFileSync("app/src/metrics-v2.json", JSON.stringify(out, null, 2) + "\n"); // o app mostra na aba Pool
  console.log(JSON.stringify(out, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("fs");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Métricas do pool v2\n\n- Carteiras ativas em 7 dias: **${out.northStar.activeWallets7d}** (30 dias: ${out.northStar.activeWallets30d})\n- Trocas: ${out.swaps} · volume R$ ${out.volumeBRL.toLocaleString("pt-BR")} (7 dias: R$ ${out.volume7dBRL.toLocaleString("pt-BR")})\n- Taxas: R$ ${out.feesBRL.total} (Rende ${out.feesBRL.rende}, Baleias ${out.feesBRL.baleia})\n- Recusas: ${JSON.stringify(out.safety.rejectsByReason)}\n`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
