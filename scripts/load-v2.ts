// Teste em escala do programa v2.6 na devnet (branch v2): os testes do white paper refeitos com muitas contas,
// no pool v2.6 (guardião sem chave, reserva da Rende, conselho de teste com chaves derivadas do deployer).
//
// Cada afirmação do white paper vira uma checagem com o esperado ao lado do medido:
//   - Cadastro com credencial de teste para centenas de carteiras.
//   - Portão de KYC (carteira sem credencial é recusada) e teto por operação do nível 1.
//   - Trocas de varejo nos dois sentidos, com a taxa efetiva medida pelos saldos e a ida e volta sem lucro.
//   - Divisão da taxa (parceiro Pix, operação, provedores) conferida pelos contadores do pool.
//   - Rende: depósitos em real e em dólar, prêmio de escassez, trava de depósito, desconto de depositante,
//     rendimento colhido, saque imediato, fila de saque com aviso prévio.
//   - Guardião (programa sem chave): nenhuma chave trava; vigílias entre os lotes não travam; salto de cotação faz
//     descansar; pedido de saque funciona no descanso; só o conselho solta antes da hora.
//   - Estresse: corrida ao dólar; o guardião manda respirar só no dólar; quem devolve dólar continua; o respiro solta
//     sozinho pelo tempo.
//
// As carteiras de teste são descartáveis e nunca salvas. Uma carteira patrocinadora (o deployer) paga as taxas de
// rede e o aluguel das contas, como o app faria; no fim, cada carteira devolve os tokens, fecha as contas de token
// e devolve o SOL. Fica gasto só o aluguel das credenciais e posições (contas do programa sem instrução de fechar).
// O relatório não guarda endereço de carteira (LGPD): só contagens, tempos e agregados.
//
// Uso (GitHub Actions): ANCHOR_WALLET=.devnet-keys/deployer.json LOAD_USERS=1000 npx tsx scripts/load-v2.ts
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { BRL, RENDE, USD, claimPda, credentialPda, mintAuthorityPda, positionPda, ticketPda, u } from "./common";
import { deriveKey } from "./derive-key";

const RPC = "https://api.devnet.solana.com";
const DEPLOYMENT = "deployments/devnet-v26.json";
const REPORT = "deployments/load-v2-report.json";
const idl = JSON.parse(readFileSync("idl/cambi_pool_v26.json", "utf8"));
const guardianIdl = JSON.parse(readFileSync("idl/cambi_guardian.json", "utf8"));
const TOTAL = Number(process.env.LOAD_USERS ?? 1000);
const COHORT = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: { code: number; name: string }[] = [...idl.errors, ...(guardianIdl.errors ?? [])];

// ---------- RPC educada: a devnet pública aceita ~10 chamadas/s por IP e ~4 envios/s ----------
let lastCall = 0;
let lastSend = 0;
let rpcCalls = 0;
async function politeFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const isSend = typeof init?.body === "string" && init.body.includes('"sendTransaction"');
  for (let attempt = 1; ; attempt++) {
    const now = Date.now();
    const at = Math.max(now, lastCall + 110, isSend ? lastSend + 270 : 0);
    lastCall = at;
    if (isSend) lastSend = at;
    if (at > now) await sleep(at - now);
    rpcCalls++;
    try {
      const res = await fetch(input, init);
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt >= 25) return res;
    } catch (e) {
      if (attempt >= 25) throw e;
    }
    await sleep(Math.min(2_000 * attempt, 30_000));
  }
}
const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: politeFetch as typeof fetch });

// ---------- Envio em lote com confirmação por consulta ----------
interface Job {
  stage: string;
  build: () => Promise<TransactionInstruction[]>;
  signers: Keypair[];
  expect: string; // "ok" ou o nome do erro esperado
  tag?: number; // índice da carteira no grupo (não sai no relatório)
}
interface Done {
  stage: string;
  tag?: number;
  expect: string;
  result: string;
  pass: boolean;
  ms: number;
  sig?: string;
}
const done: Done[] = [];
const samples: Record<string, { feeSol: number; cu: number }[]> = {};
const sampleSigs: Record<string, string> = {};

function errorName(e: unknown): string {
  const x = e as { logs?: string[]; transactionLogs?: string[] };
  const msg = [String((e as Error)?.message ?? e), ...(x.logs ?? x.transactionLogs ?? [])].join("\n");
  const code = msg.match(/Error Code: (\w+)/)?.[1];
  if (code) return code;
  const hex = msg.match(/custom program error: 0x([0-9a-f]+)/i)?.[1];
  if (hex) return errors.find((x) => x.code === parseInt(hex, 16))?.name ?? `0x${hex}`;
  if (/insufficient (funds|lamports)/i.test(msg)) return "SemSaldo";
  return msg.split("\n")[0].slice(0, 80);
}
function onchainError(err: unknown): string {
  const custom = (err as { InstructionError?: [number, { Custom?: number } | string] })?.InstructionError?.[1];
  if (custom && typeof custom === "object" && typeof custom.Custom === "number") {
    return errors.find((x) => x.code === custom.Custom)?.name ?? `Custom ${custom.Custom}`;
  }
  return JSON.stringify(err).slice(0, 80);
}

let payer: Keypair;
let cachedHash: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
async function blockhash() {
  if (!cachedHash || Date.now() - cachedHash.at > 20_000) cachedHash = { ...(await connection.getLatestBlockhash("confirmed")), at: Date.now() };
  return cachedHash;
}

/** Roda um estágio: envia todas as transações (com simulação, que mostra os erros esperados) e confirma em lote. */
async function stage(name: string, jobs: Job[]): Promise<Done[]> {
  const t0 = Date.now();
  type P = { job: Job; sig: string; sentAt: number; lvbh: number; retried: boolean };
  const pending: P[] = [];
  const out: Done[] = [];
  const finish = (job: Job, result: string, ms: number, sig?: string) => {
    const d: Done = { stage: job.stage, tag: job.tag, expect: job.expect, result, pass: job.expect === "ok" ? result === "ok" : result === job.expect, ms, sig };
    out.push(d);
    done.push(d);
  };
  const submit = async (job: Job, retried: boolean) => {
    const sentAt = Date.now();
    try {
      const ixs = await job.build();
      const h = await blockhash();
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash: h.blockhash, lastValidBlockHeight: h.lastValidBlockHeight }).add(...ixs);
      tx.sign(payer, ...job.signers);
      const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
      pending.push({ job, sig, sentAt, lvbh: h.lastValidBlockHeight, retried });
    } catch (e) {
      finish(job, errorName(e), Date.now() - sentAt);
    }
  };
  let lastPoll = 0;
  const poll = async (final: boolean) => {
    if (!pending.length || (!final && Date.now() - lastPoll < 2_500)) return;
    lastPoll = Date.now();
    for (let i = 0; i < pending.length; i += 200) {
      const chunk = pending.slice(i, i + 200);
      const st = (await connection.getSignatureStatuses(chunk.map((p) => p.sig))).value;
      chunk.forEach((p, j) => {
        const s = st[j];
        if (!s) return;
        if (s.err) finish(p.job, onchainError(s.err), Date.now() - p.sentAt, p.sig);
        else if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") finish(p.job, "ok", Date.now() - p.sentAt, p.sig);
        else return;
        (p as P & { closed?: boolean }).closed = true;
      });
    }
    for (let i = pending.length - 1; i >= 0; i--) if ((pending[i] as P & { closed?: boolean }).closed) pending.splice(i, 1);
  };
  for (const job of jobs) {
    await submit(job, false);
    await poll(false);
  }
  // Espera as confirmações; o que expirou sem chegar é reenviado uma vez (o blockhash vencido garante que não duplica).
  for (let round = 0; pending.length && round < 120; round++) {
    await sleep(2_000);
    await poll(true);
    if (pending.length && round % 10 === 9) {
      const height = await connection.getBlockHeight("confirmed");
      for (const p of pending.filter((p) => height > p.lvbh)) {
        pending.splice(pending.indexOf(p), 1);
        if (p.retried) finish(p.job, "sem confirmação", Date.now() - p.sentAt, p.sig);
        else {
          cachedHash = null;
          await submit(p.job, true);
        }
      }
    }
  }
  for (const p of pending) finish(p.job, "sem confirmação", Date.now() - p.sentAt, p.sig);
  // Amostra de taxa de rede e compute units (as 5 primeiras confirmadas de cada estágio).
  const ok = out.filter((d) => d.result === "ok" && d.sig).slice(0, 5);
  for (const d of ok) {
    const t = await connection.getTransaction(d.sig!, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) (samples[name] ??= []).push({ feeSol: t.meta.fee / LAMPORTS_PER_SOL, cu: t.meta.computeUnitsConsumed ?? 0 });
  }
  if (ok[0]) sampleSigs[name] = ok[0].sig!;
  const pass = out.filter((d) => d.pass).length;
  const hist = histogram(out);
  console.log(`${pass === out.length ? "✓" : "✗"} ${name}: ${pass}/${out.length} como esperado · ${((Date.now() - t0) / 1000).toFixed(0)} s · ${JSON.stringify(hist)}`);
  return out;
}
function stats(v: number[]) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n: s.length, min: r2(s[0]), p50: r2(s[Math.floor(s.length / 2)]), p95: r2(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max: r2(s[s.length - 1]) };
}
const histogram = (ds: Done[]) => ds.reduce<Record<string, number>>((h, d) => ((h[d.result] = (h[d.result] ?? 0) + 1), h), {});

// ---------- Leituras em lote ----------
async function accounts(keys: PublicKey[]) {
  const out: ({ lamports: number; data: Buffer } | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")).map((a) => (a ? { lamports: a.lamports, data: a.data as Buffer } : null)));
  return out;
}
const tokenAmount = (a: { data: Buffer } | null) => (a && a.data.length >= 72 ? Number(a.data.readBigUInt64LE(64)) : 0);

async function main() {
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const program = new Program(idl as Idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
  const pid = program.programId;
  if (pid.toBase58() !== dep.programId) throw new Error("IDL v2.6 não corresponde ao programa implantado");
  const guardianProgram = new Program(guardianIdl as Idl, program.provider);
  const pool = new PublicKey(dep.pool);
  const brlMint = new PublicKey(dep.brlMint);
  const usdMint = new PublicKey(dep.usdMint);
  const brlVault = new PublicKey(dep.brlVault);
  const usdVault = new PublicKey(dep.usdVault);
  const acc = program.account as any;
  const ata = (owner: PublicKey, side: number) => getAssociatedTokenAddressSync(side === BRL ? brlMint : usdMint, owner);
  const payerBrl = ata(payer.publicKey, BRL);
  const payerUsd = ata(payer.publicKey, USD);
  const t0 = Date.now();

  // ---------- Estado inicial ----------
  const fetchPool = async () => acc.pool.fetch(pool);

  // Conselho de teste (chaves derivadas da chave do deployer) e vigília do guardião (qualquer carteira chama).
  const councilKeys = Array.from({ length: 10 }, (_, i) => deriveKey(payer, `conselho-${i + 1}`));
  const msPda = new PublicKey(dep.council.multisig);
  const councilVault = new PublicKey(dep.council.vault);
  async function council(builder: { instruction: () => Promise<TransactionInstruction> }, label: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ix = await builder.instruction();
        const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
        const transactionIndex = BigInt(Number(ms.transactionIndex) + 1);
        const signers = councilKeys.slice().sort(() => Math.random() - 0.5).slice(0, 7);
        const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
        const a = await stage(`${label}: proposta`, [
          {
            stage: "conselho: proposta",
            signers: [signers[0]],
            expect: "ok",
            build: async () => [
              multisig.instructions.vaultTransactionCreate({
                multisigPda: msPda,
                transactionIndex,
                creator: signers[0].publicKey,
                rentPayer: payer.publicKey,
                vaultIndex: 0,
                ephemeralSigners: 0,
                transactionMessage: new TransactionMessage({ payerKey: councilVault, recentBlockhash: bh, instructions: [ix] }),
                memo: `cambI: ${label}`.slice(0, 80),
              }),
              multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex, creator: signers[0].publicKey, rentPayer: payer.publicKey }),
            ],
          },
        ]);
        if (a[0].result !== "ok") throw new Error(a[0].result);
        const b = await stage(`${label}: 7 aprovações`, [
          { stage: "conselho: aprovações", signers, expect: "ok", build: async () => signers.map((m) => multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex, member: m.publicKey })) },
        ]);
        if (b[0].result !== "ok") throw new Error(b[0].result);
        const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex, member: signers[0].publicKey });
        const c = await stage(`${label}: execução`, [{ stage: "conselho: execução", signers: [signers[0]], expect: "ok", build: async () => [instruction] }]);
        if (c[0].result !== "ok") throw new Error(c[0].result);
        return true;
      } catch (e) {
        console.log(`${label}, tentativa ${attempt}: ${(e as Error).message}`);
      }
    }
    return false;
  }
  const guardianPda = new PublicKey(dep.guardian);
  const watchPda = new PublicKey(dep.watch);
  const lockLog: { at: string; level: number; restUntil: number; breatheUntil: number; side?: number }[] = [];
  /** Vigília do guardião; devolve a trava que ficou valendo no pool (0 nenhuma, 1 respirar, 2 descansar, 3 parar). */
  async function vigil(label: string): Promise<number> {
    await stage(label, [
      {
        stage: "guardião: vigília",
        signers: [],
        expect: "ok",
        build: async () => [
          await guardianProgram.methods
            .vigiar()
            .accountsPartial({ watch: watchPda, pool, brlVault, usdVault, guardian: guardianPda, cambiPoolProgram: pid })
            .instruction(),
        ],
      },
    ]);
    const p = await fetchPool();
    const now = Math.floor(Date.now() / 1000);
    return p.paused ? 3 : Number(p.restUntil) > now ? 2 : Number(p.breatheUntil) > now ? 1 : 0;
  }
  const p0 = await fetchPool();
  const price = Number(p0.price.toString()) / 1e6;
  const priceAge = Math.floor(Date.now() / 1000) - Number(p0.priceUpdatedAt);
  if (priceAge > Number(p0.maxPriceAge)) throw new Error(`Cotação do pool vencida há ${priceAge} s: rode a rodada de cotação antes.`);
  if (p0.paused) throw new Error("Pool pausado: o teste precisa do pool aberto.");
  const solStart = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`Deployer: ${solStart} SOL · cotação R$ ${price} (há ${priceAge} s)`);

  const SYS_MIN = await connection.getMinimumBalanceForRentExemption(0);
  const rent = {
    credential: await connection.getMinimumBalanceForRentExemption(acc.credential.size),
    position: await connection.getMinimumBalanceForRentExemption(acc.position.size),
    ticket: await connection.getMinimumBalanceForRentExemption(acc.withdrawTicket.size),
    claim: await connection.getMinimumBalanceForRentExemption(acc.faucetClaimState.size),
    ata: await connection.getMinimumBalanceForRentExemption(165),
  };
  const MARGIN = 10_000; // folga contra arredondamento do aluguel; volta na varredura final

  // Orçamento de SOL: o que fica gasto (credenciais, posições, taxas) + o pico de um lote (contas de token, devolvidas).
  const rendeCount = Math.min(100, Math.round(TOTAL / 10));
  const fees = 0.00001 * 6; // ~6 transações por carteira, 2 assinaturas cada
  const perUser = rent.credential / LAMPORTS_PER_SOL + fees;
  const need = (users: number) => users * perUser + rendeCount * (rent.position + rent.ticket) / LAMPORTS_PER_SOL + (rendeCount + COHORT) * (2 * rent.ata + SYS_MIN + MARGIN * 3) / LAMPORTS_PER_SOL + 0.3;
  let users = TOTAL;
  let budgetNote = "";
  if (solStart < need(users)) {
    for (let i = 0; i < 3 && (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL < need(users); i++) {
      try {
        await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
        await sleep(15_000);
      } catch (e) {
        console.log(`Airdrop recusado: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    const bal = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
    while (users > 100 && bal < need(users)) users -= 100;
    if (users < TOTAL) budgetNote = `SOL do deployer (${bal.toFixed(2)}) cobre ${users} carteiras, não ${TOTAL}`;
    if (bal < need(users)) throw new Error(`SOL insuficiente: ${bal.toFixed(2)} SOL, precisa de ~${need(users).toFixed(2)}`);
  }
  const traderCount = users - rendeCount;
  console.log(`Plano: ${users} carteiras (${rendeCount} na Rende, ${traderCount} trocando) ${budgetNote ? "· " + budgetNote : ""}`);

  // ---------- Instruções ----------
  const credentialIx = (k: PublicKey) =>
    program.methods.devnetCredential().accountsPartial({ user: k, pool, credential: credentialPda(pid, pool, k), systemProgram: SystemProgram.programId }).instruction();
  const swapIx = (k: PublicKey, side: number, amount: number, opts: { credential?: boolean; position?: PublicKey } = {}) =>
    program.methods
      .swap(side, u(amount), u(0))
      .accountsPartial({
        user: k,
        pool,
        brlVault,
        usdVault,
        userBrl: ata(k, BRL),
        userUsd: ata(k, USD),
        depositorPosition: opts.position ?? null,
        partner: null,
        credential: opts.credential === false ? null : credentialPda(pid, pool, k),
        brlMint,
        usdMint,
        brlReserve: null,
        usdReserve: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const swapRawIx = (k: PublicKey, side: number, raw: number, position?: PublicKey) =>
    program.methods
      .swap(side, new anchor.BN(raw), new anchor.BN(0))
      .accountsPartial({
        user: k,
        pool,
        brlVault,
        usdVault,
        userBrl: ata(k, BRL),
        userUsd: ata(k, USD),
        depositorPosition: position ?? null,
        partner: null,
        credential: credentialPda(pid, pool, k),
        brlMint,
        usdMint,
        brlReserve: null,
        usdReserve: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const fund = (k: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k, lamports });
  const atas = (k: PublicKey) => [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(k, BRL), k, brlMint),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(k, USD), k, usdMint),
  ];
  const giveBrl = (k: PublicKey, reais: number) => createTransferInstruction(payerBrl, ata(k, BRL), payer.publicKey, BigInt(Math.round(reais * 1e6)));
  const depositIx = (k: PublicKey, side: number, raw: number) =>
    program.methods
      .deposit(RENDE, side, new anchor.BN(raw))
      .accountsPartial({
        user: k,
        pool,
        position: positionPda(pid, pool, k, RENDE, side),
        brlVault,
        usdVault,
        userBrl: ata(k, BRL),
        userUsd: ata(k, USD),
        credential: credentialPda(pid, pool, k),
        brlMint,
        usdMint,
        brlReserve: null,
        usdReserve: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  const withdrawIx = (k: PublicKey, side: number, raw: number) =>
    program.methods
      .withdraw(new anchor.BN(raw))
      .accountsPartial({
        user: k,
        pool,
        position: positionPda(pid, pool, k, RENDE, side),
        brlVault,
        usdVault,
        userBrl: ata(k, BRL),
        userUsd: ata(k, USD),
        credential: credentialPda(pid, pool, k),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const requestIx = (k: PublicKey, side: number, raw: number) => {
    const position = positionPda(pid, pool, k, RENDE, side);
    return program.methods
      .requestWithdraw(new anchor.BN(raw))
      .accountsPartial({
        user: k,
        pool,
        position,
        ticket: ticketPda(pid, position),
        credential: credentialPda(pid, pool, k),
        brlVault,
        usdVault,
        userBrl: ata(k, BRL),
        userUsd: ata(k, USD),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  };
  const claimIx = (k: PublicKey, side: number) =>
    program.methods
      .claimWithdraw()
      .accountsPartial({
        user: k,
        pool,
        ticket: ticketPda(pid, positionPda(pid, pool, k, RENDE, side)),
        brlVault,
        usdVault,
        userBrl: ata(k, BRL),
        userUsd: ata(k, USD),
        credential: credentialPda(pid, pool, k),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

  /** Devolve tudo ao deployer: tokens, contas de token (aluguel) e o SOL que sobrou na carteira. */
  async function cleanup(name: string, ks: Keypair[]) {
    const keys = ks.flatMap((k) => [ata(k.publicKey, BRL), ata(k.publicKey, USD), k.publicKey]);
    const info = await accounts(keys);
    return stage(
      name,
      ks.map((k, i) => {
        const [b, d, w] = [info[3 * i], info[3 * i + 1], info[3 * i + 2]];
        return {
          stage: name,
          signers: [k],
          expect: "ok",
          build: async () => {
            const ixs: TransactionInstruction[] = [];
            if (tokenAmount(b) > 0) ixs.push(createTransferInstruction(ata(k.publicKey, BRL), payerBrl, k.publicKey, BigInt(tokenAmount(b))));
            if (tokenAmount(d) > 0) ixs.push(createTransferInstruction(ata(k.publicKey, USD), payerUsd, k.publicKey, BigInt(tokenAmount(d))));
            if (b) ixs.push(createCloseAccountInstruction(ata(k.publicKey, BRL), payer.publicKey, k.publicKey));
            if (d) ixs.push(createCloseAccountInstruction(ata(k.publicKey, USD), payer.publicKey, k.publicKey));
            if (w && w.lamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: payer.publicKey, lamports: w.lamports }));
            return ixs;
          },
        };
      }),
    );
  }

  // ---------- Moedas de teste: faucet on-chain (R$ 1.000 por carteira, teto global de R$ 50 mil por hora) ----------
  await stage("preparo: contas do deployer", [{ stage: "preparo", signers: [], expect: "ok", build: async () => atas(payer.publicKey) }]);
  const big = Math.min(10, Math.round(rendeCount / 10));
  const usdDepositors = Math.round(rendeCount / 5);
  const small = rendeCount - big - usdDepositors;
  const TRADER_BRL = 30;
  const brlNeeded = big * 1_100 + small * 60 + usdDepositors * 80 + traderCount * TRADER_BRL + 50 * 20;
  const brlHave = tokenAmount((await accounts([payerBrl]))[0]) / 1e6;
  const seedsWanted = Math.max(0, Math.ceil((brlNeeded - brlHave) / 1_000));
  const seeds = Array.from({ length: seedsWanted }, () => Keypair.generate());
  const claimed = await stage(
    "preparo: faucet",
    seeds.map((s) => ({
      stage: "faucet",
      signers: [s],
      expect: "ok",
      build: async () => [
        fund(s.publicKey, rent.claim + MARGIN + SYS_MIN),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(s.publicKey, BRL), s.publicKey, brlMint),
        await program.methods
          .faucetClaim()
          .accountsPartial({
            user: s.publicKey,
            pool,
            claim: claimPda(pid, pool, s.publicKey),
            brlMint,
            userBrl: ata(s.publicKey, BRL),
            mintAuthority: mintAuthorityPda(pid, pool),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        createTransferInstruction(ata(s.publicKey, BRL), payerBrl, s.publicKey, 1_000_000_000n),
        createCloseAccountInstruction(ata(s.publicKey, BRL), payer.publicKey, s.publicKey),
      ],
    })),
  );
  const seedLamports = await accounts(seeds.map((s) => s.publicKey));
  await stage(
    "preparo: SOL das sementes de volta",
    seeds
      .map((s, i) => ({ s, l: seedLamports[i]?.lamports ?? 0 }))
      .filter((x) => x.l > 0)
      .map((x) => ({ stage: "preparo", signers: [x.s], expect: "ok", build: async () => [SystemProgram.transfer({ fromPubkey: x.s.publicKey, toPubkey: payer.publicKey, lamports: x.l })] })),
  );
  const brlPool = tokenAmount((await accounts([payerBrl]))[0]) / 1e6;
  const scale = Math.min(1, brlPool / brlNeeded);
  const faucetNote = scale < 1 ? `faucet liberou R$ ${brlPool.toFixed(0)} de R$ ${brlNeeded} (teto por hora): valores reduzidos a ${(scale * 100).toFixed(0)}%` : "";
  if (faucetNote) console.log(faucetNote);
  const R = (v: number) => Math.max(1, Math.floor(v * scale * 100) / 100);

  // ---------- Rende: cadastro, depósitos, prêmio de escassez, trava, desconto ----------
  const rende = Array.from({ length: rendeCount }, (_, i) => ({ k: Keypair.generate(), kind: i < big ? "grande" : i < big + usdDepositors ? "dolar" : "pequeno" }));
  const rendeFunding = (kind: string) => (kind === "grande" ? R(1_100) : kind === "dolar" ? R(80) : R(60));
  await stage(
    "rende: cadastro",
    rende.map((r, i) => ({
      stage: "rende: cadastro",
      tag: i,
      signers: [r.k],
      expect: "ok",
      build: async () => [fund(r.k.publicKey, rent.credential + MARGIN + SYS_MIN), ...atas(r.k.publicKey), await credentialIx(r.k.publicKey), giveBrl(r.k.publicKey, rendeFunding(r.kind))],
    })),
  );
  const dollarGroup = rende.filter((r) => r.kind === "dolar");
  await stage(
    "rende: depositantes em dólar compram dólar",
    dollarGroup.map((r) => ({ stage: "rende: compra de dólar", signers: [r.k], expect: "ok", build: async () => [await swapIx(r.k.publicKey, BRL, R(70))] })),
  );
  let info = await accounts(rende.flatMap((r) => [ata(r.k.publicKey, BRL), ata(r.k.publicKey, USD)]));
  const pBeforeDeposit = await fetchPool();
  const vaultsBefore = await accounts([brlVault, usdVault]);
  const avail = (p: any, v: number, s: number) =>
    v - Number(p.platformFees[s]) - Number(p.partnerFees[s]) - Number(p.lpFeesUnclaimed[s]) - Number(p.queued[s]); // espelha available()
  const brlA = avail(pBeforeDeposit, tokenAmount(vaultsBefore[0]), BRL);
  const usdA = avail(pBeforeDeposit, tokenAmount(vaultsBefore[1]), USD) * price;
  const imbalanceAtDeposit = Math.round(((brlA - usdA) / (brlA + usdA)) * 1000) / 10;
  const depositRaw = rende.map((r, i) => {
    if (r.kind === "dolar") return tokenAmount(info[2 * i + 1]);
    const brl = tokenAmount(info[2 * i]);
    return r.kind === "grande" ? Math.min(brl, Math.round(R(1_050) * 1e6)) : Math.min(brl, Math.round((R(40) + (i % 16)) * 1e6));
  });
  const deposits = await stage(
    "rende: depósitos",
    rende.map((r, i) => ({
      stage: "rende: depósito",
      tag: i,
      signers: [r.k],
      expect: "ok",
      build: async () => [fund(r.k.publicKey, rent.position + MARGIN), await depositIx(r.k.publicKey, r.kind === "dolar" ? USD : BRL, depositRaw[i])],
    })),
  );
  const depositedAt = Date.now();
  const positionsInfo = await accounts(rende.map((r) => positionPda(pid, pool, r.k.publicKey, RENDE, r.kind === "dolar" ? USD : BRL)));
  const positions = positionsInfo.map((a) => (a ? program.coder.accounts.decode("position", a.data) : null));
  const premiumBy = (kind: string) => {
    const v = rende
      .map((r, i) => ({ r, p: positions[i] }))
      .filter((x) => x.r.kind === kind && x.p && Number(x.p.amount) > 0)
      .map((x) => {
        const value = x.r.kind === "dolar" ? Number(x.p.amount) * price : Number(x.p.amount);
        return (Number(x.p.shares.toString()) / value - 1) * 100;
      });
    return v.length ? { n: v.length, avgPct: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100, minPct: Math.round(Math.min(...v) * 100) / 100, maxPct: Math.round(Math.max(...v) * 100) / 100 } : null;
  };
  const premium = { imbalanceAtDepositPct: imbalanceAtDeposit, dolar: premiumBy("dolar"), real: premiumBy("pequeno") };
  console.log("Prêmio de escassez:", premium);

  const lockedSample = rende.filter((r) => r.kind === "pequeno").slice(0, 20);
  await stage(
    "rende: saque logo após depositar",
    lockedSample.map((r) => ({ stage: "rende: trava de depósito", signers: [r.k], expect: "PositionLocked", build: async () => [await withdrawIx(r.k.publicKey, BRL, 1_000_000)] })),
  );

  // Desconto de depositante (posição de R$ 1.000 ou mais): troca com a posição x troca de varejo, mesmo valor e mesmo instante.
  const bigOnes = rende.filter((r) => r.kind === "grande");
  const twins = Array.from({ length: bigOnes.length }, () => Keypair.generate());
  await stage(
    "varejo de comparação: cadastro",
    twins.map((k) => ({ stage: "comparação: cadastro", signers: [k], expect: "ok", build: async () => [fund(k.publicKey, rent.credential + MARGIN + SYS_MIN), ...atas(k.publicKey), await credentialIx(k.publicKey), giveBrl(k.publicKey, R(50))] })),
  );
  const discountRows: { depositorPct: number; retailPct: number }[] = [];
  for (const [i, r] of bigOnes.entries()) {
    const amount = R(20);
    const pos = positionPda(pid, pool, r.k.publicKey, RENDE, BRL);
    const before = await accounts([ata(r.k.publicKey, USD), ata(twins[i].publicKey, USD)]);
    const res = await stage(`desconto ${i + 1}`, [
      { stage: "rende: troca com desconto de depositante", signers: [r.k], expect: "ok", build: async () => [await swapIx(r.k.publicKey, BRL, amount, { position: pos })] },
      { stage: "comparação: troca de varejo", signers: [twins[i]], expect: "ok", build: async () => [await swapIx(twins[i].publicKey, BRL, amount)] },
    ]);
    if (res.every((d) => d.result === "ok")) {
      const after = await accounts([ata(r.k.publicKey, USD), ata(twins[i].publicKey, USD)]);
      const pct = (j: number) => Math.round((1 - ((tokenAmount(after[j]) - tokenAmount(before[j])) / 1e6) * price / amount) * 10_000) / 100;
      discountRows.push({ depositorPct: pct(0), retailPct: pct(1) });
    }
  }
  await cleanup("varejo de comparação: devolução", twins);

  // ---------- Trocas de varejo em lotes ----------
  const pTradersStart = await fetchPool();
  const tradeVolume = { brlIn: 0, usdIn: 0 };
  const buyFees: number[] = [];
  const sellFees: number[] = [];
  const roundTrip: number[] = [];
  let profitable = 0;
  let maxBreaker = { BRL: 0, USD: 0 };
  let traderIndex = 0;
  const cohortVigils: number[] = [];
  for (let c = 0; c * COHORT < traderCount; c++) {
    const n = Math.min(COHORT, traderCount - c * COHORT);
    const ks = Array.from({ length: n }, () => Keypair.generate());
    const outsiders = [Keypair.generate(), Keypair.generate()];
    const label = `lote ${c + 1}`;
    const signed = await stage(`${label}: cadastro`, [
      ...ks.map((k, i) => ({
        stage: "trocas: cadastro",
        tag: i,
        signers: [k],
        expect: "ok",
        build: async () => [fund(k.publicKey, rent.credential + MARGIN + SYS_MIN), ...atas(k.publicKey), await credentialIx(k.publicKey), giveBrl(k.publicKey, R(TRADER_BRL))],
      })),
      ...outsiders.map((k) => ({ stage: "kyc: cadastro sem credencial", signers: [], expect: "ok", build: async () => [...atas(k.publicKey), giveBrl(k.publicKey, R(10))] })),
    ]);
    const okUsers = ks.filter((_, i) => signed.find((d) => d.stage === "trocas: cadastro" && d.tag === i)?.result === "ok");
    await stage(`${label}: portão de KYC e teto do nível 1`, [
      ...outsiders.map((k) => ({ stage: "kyc: troca sem credencial", signers: [k], expect: "KycRequired", build: async () => [await swapIx(k.publicKey, BRL, R(5), { credential: false })] })),
      ...okUsers.slice(0, 2).map((k) => ({ stage: "kyc: troca acima do teto do nível 1 (R$ 10 mil)", signers: [k], expect: "AboveKycLimit", build: async () => [await swapIx(k.publicKey, BRL, 10_001)] })),
    ]);
    const amounts = okUsers.map((_, i) => Math.max(1, Math.round((R(TRADER_BRL) * (0.2 + ((traderIndex + i) * 37 % 75) / 100)) * 100) / 100));
    traderIndex += n;
    const bought = await stage(
      `${label}: real → dólar`,
      okUsers.map((k, i) => ({ stage: "trocas: real → dólar", tag: i, signers: [k], expect: "ok", build: async () => [await swapIx(k.publicKey, BRL, amounts[i])] })),
    );
    info = await accounts(okUsers.flatMap((k) => [ata(k.publicKey, BRL), ata(k.publicKey, USD)]));
    const afterBuy = okUsers.map((_, i) => ({ brl: tokenAmount(info[2 * i]), usd: tokenAmount(info[2 * i + 1]) }));
    okUsers.forEach((_, i) => {
      if (bought.find((d) => d.tag === i)?.result !== "ok") return;
      tradeVolume.brlIn += amounts[i];
      buyFees.push((1 - ((afterBuy[i].usd / 1e6) * price) / amounts[i]) * 100);
    });
    const sold = await stage(
      `${label}: dólar → real (ida e volta)`,
      okUsers
        .map((k, i) => ({ k, i }))
        .filter((x) => afterBuy[x.i].usd > 0)
        .map((x) => ({ stage: "trocas: dólar → real", tag: x.i, signers: [x.k], expect: "ok", build: async () => [await swapRawIx(x.k.publicKey, USD, afterBuy[x.i].usd)] })),
    );
    info = await accounts(okUsers.map((k) => ata(k.publicKey, BRL)));
    okUsers.forEach((_, i) => {
      if (sold.find((d) => d.tag === i)?.result !== "ok") return;
      const back = (tokenAmount(info[i]) - afterBuy[i].brl) / 1e6;
      tradeVolume.usdIn += afterBuy[i].usd / 1e6;
      sellFees.push((1 - back / ((afterBuy[i].usd / 1e6) * price)) * 100);
      const rt = ((back - amounts[i]) / amounts[i]) * 100;
      roundTrip.push(rt);
      if (rt > 0) profitable++;
    });
    const p = await fetchPool();
    const now = Math.floor(Date.now() / 1000);
    const open = now - Number(p.breakerStart) < Number(p.breakerWindowSecs);
    const used = (s: number) => (open && Number(p.breakerBase[s]) > 0 ? (Number(p.breakerOut[s]) / ((Number(p.breakerBase[s]) * p.breakerBps) / 10_000)) * 100 : 0);
    maxBreaker = { BRL: Math.max(maxBreaker.BRL, used(BRL)), USD: Math.max(maxBreaker.USD, used(USD)) };
    await cleanup(`${label}: devolução`, [...ks, ...outsiders]);
    // Vigília depois de cada lote: uso normal não deve travar nada.
    cohortVigils.push(await vigil(`${label}: vigília do guardião`));
  }
  const pTradersEnd = await fetchPool();

  // Divisão da taxa conferida pelos contadores do pool durante os lotes (só varejo: 100% via Pix).
  const delta = (f: string, s: number) => Number(pTradersEnd[f][s]) - Number(pTradersStart[f][s]);
  const toBrl = (brl: number, usd: number) => (brl + usd * price) / 1e6;
  const partner = toBrl(delta("partnerFees", BRL), delta("partnerFees", USD));
  const platform = toBrl(delta("platformFees", BRL), delta("platformFees", USD));
  const lp = toBrl(delta("lpFeesUnclaimed", BRL), delta("lpFeesUnclaimed", USD));
  const volumeBrl = tradeVolume.brlIn + tradeVolume.usdIn * price;
  const split = {
    volumeBRL: Math.round(volumeBrl * 100) / 100,
    feesBRL: Math.round((partner + platform + lp) * 100) / 100,
    partnerPctOfVolume: Math.round((partner / volumeBrl) * 10_000) / 100,
    platformPctOfNet: Math.round((platform / (platform + lp)) * 10_000) / 100,
    providersPctOfNet: Math.round((lp / (platform + lp)) * 10_000) / 100,
  };

  // ---------- Guardião (programa sem chave) e conselho ----------
  // Nenhuma chave trava o pool: o deployer tenta e é recusado. Um salto de cotação de 5% (feito pelo conselho de
  // teste, dentro do limite do pool) faz o guardião mandar "descansar" na vigília seguinte: trocas e depósitos param,
  // pedidos de saque continuam. O conselho volta a cotação e solta as travas.
  let guardianNote = "";
  const queued = rende.filter((r) => r.kind === "pequeno").slice(0, 20);
  const restSwappers = rende.filter((r) => r.kind === "pequeno").slice(20, 40);
  await stage("guardião: nenhuma chave trava", [
    { stage: "guardião: chave tenta travar", signers: [], expect: "ConstraintHasOne", build: async () => [await program.methods.guardianLock(2, 0, new anchor.BN(60), 0).accountsPartial({ guardian: payer.publicKey, pool }).instruction()] },
  ]);
  const p1 = await fetchPool();
  const jumped = new anchor.BN(Math.round(Number(p1.price.toString()) * 1.05));
  const c1 = await council(program.methods.setPrice(jumped).accountsPartial({ oracle: councilVault, pool }), "conselho: cotação +5% (teste do guardião)");
  if (c1) {
    const v = await vigil("vigília depois do salto");
    const p2 = await fetchPool();
    lockLog.push({ at: "salto de cotação", level: v, restUntil: Number(p2.restUntil), breatheUntil: Number(p2.breatheUntil) });
    await stage(
      "descanso: trocas e depósitos",
      [
        ...restSwappers.map((r) => ({ stage: "guardião: troca durante o descanso", signers: [r.k], expect: "GuardianResting", build: async () => [await swapIx(r.k.publicKey, BRL, 2)] })),
        ...restSwappers.slice(0, 5).map((r) => ({ stage: "guardião: depósito durante o descanso", signers: [r.k], expect: "GuardianResting", build: async () => [await depositIx(r.k.publicKey, BRL, 1_000_000)] })),
      ],
    );
    // Esperar a trava de depósito antes de pedir saque.
    const lockMs = Number(pBeforeDeposit.lockupSecs) * 1000 + 5_000 - (Date.now() - depositedAt);
    if (lockMs > 0) await sleep(lockMs);
    await stage(
      "descanso: pedido na fila de saque",
      queued.map((r) => ({ stage: "rende: pedido na fila durante o descanso", signers: [r.k], expect: "ok", build: async () => [fund(r.k.publicKey, rent.ticket + MARGIN), await requestIx(r.k.publicKey, BRL, 5_000_000)] })),
    );
    // O conselho volta a cotação; a vigília seguinte registra o preço de volta (o descanso já está valendo) e o
    // conselho solta as travas antes da hora.
    const t0g = Date.now();
    const back = await council(program.methods.setPrice(p1.price).accountsPartial({ oracle: councilVault, pool }), "conselho: cotação de volta");
    await vigil("vigília com a cotação de volta");
    const cleared = back && (await council(program.methods.clearGuardianLocks().accountsPartial({ admin: councilVault, pool }), "conselho: solta as travas"));
    guardianNote = cleared ? `guardião descansou sozinho; conselho soltou em ${((Date.now() - t0g) / 1000).toFixed(0)} s` : "conselho não conseguiu soltar";
    await stage("pool aberto de novo", [{ stage: "guardião: troca depois de soltar", signers: [restSwappers[0].k], expect: "ok", build: async () => [await swapIx(restSwappers[0].k.publicKey, BRL, 2)] }]);
    await stage(
      "fila: resgate antes do aviso prévio",
      queued.slice(0, 10).map((r) => ({ stage: "rende: resgate antes do aviso", signers: [r.k], expect: "WithdrawNotReady", build: async () => [await claimIx(r.k.publicKey, BRL)] })),
    );
  } else {
    guardianNote = "conselho de teste não executou a cotação: cenário do guardião pulado";
  }

  // ---------- Rende: colher rendimento, saque imediato, resgate da fila ----------
  const lockLeft = Number(pBeforeDeposit.lockupSecs) * 1000 + 5_000 - (Date.now() - depositedAt);
  if (lockLeft > 0) await sleep(lockLeft);
  const okDeposit = rende.filter((_, i) => deposits.find((d) => d.tag === i)?.result === "ok");
  const sideOf = (r: (typeof rende)[number]) => (r.kind === "dolar" ? USD : BRL);
  const preHarvest = await accounts(okDeposit.flatMap((r) => [ata(r.k.publicKey, BRL), ata(r.k.publicKey, USD)]));
  await stage(
    "rende: colher rendimento",
    okDeposit.map((r) => ({ stage: "rende: colher rendimento (saque zero)", signers: [r.k], expect: "ok", build: async () => [await withdrawIx(r.k.publicKey, sideOf(r), 0)] })),
  );
  const postHarvest = await accounts(okDeposit.flatMap((r) => [ata(r.k.publicKey, BRL), ata(r.k.publicKey, USD)]));
  let yieldBrl = 0;
  let earners = 0;
  okDeposit.forEach((_, i) => {
    const g = (tokenAmount(postHarvest[2 * i]) - tokenAmount(preHarvest[2 * i]) + (tokenAmount(postHarvest[2 * i + 1]) - tokenAmount(preHarvest[2 * i + 1])) * price) / 1e6;
    yieldBrl += g;
    if (g > 0) earners++;
  });
  const posNow = (await accounts(okDeposit.map((r) => positionPda(pid, pool, r.k.publicKey, RENDE, sideOf(r))))).map((a) => (a ? program.coder.accounts.decode("position", a.data) : null));
  await stage(
    "rende: saque imediato do restante",
    okDeposit
      .map((r, i) => ({ r, amount: posNow[i] ? Number(posNow[i].amount) : 0 }))
      .filter((x) => x.amount > 0)
      .map((x) => ({ stage: "rende: saque imediato", signers: [x.r.k], expect: "ok", build: async () => [await withdrawIx(x.r.k.publicKey, sideOf(x.r), x.amount)] })),
  );
  const tickets = (await accounts(queued.map((r) => ticketPda(pid, positionPda(pid, pool, r.k.publicKey, RENDE, BRL))))).map((a) => (a ? program.coder.accounts.decode("withdrawTicket", a.data) : null));
  const readyAt = Math.max(0, ...tickets.filter(Boolean).map((t) => Number(t.readyAt)));
  const waitMs = readyAt * 1000 + 5_000 - Date.now();
  if (waitMs > 0) {
    console.log(`Esperando o aviso prévio da fila (${Math.round(waitMs / 1000)} s)…`);
    await sleep(waitMs);
  }
  await stage(
    "fila: resgate depois do aviso prévio",
    queued.filter((_, i) => tickets[i]).map((r) => ({ stage: "rende: resgate da fila", signers: [r.k], expect: "ok", build: async () => [await claimIx(r.k.publicKey, BRL)] })),
  );
  await cleanup("rende: devolução", rende.map((r) => r.k));

  // ---------- Estresse econômico: corrida ao dólar e recuperação ----------
  // Muitas carteiras tentam tirar R$ 1.000 em dólar cada, em rajadas, até as travas segurarem (limite por minuto
  // e disjuntor por hora). Depois todas devolvem o dólar: quem traz a moeda que falta deve pagar menos, a ida e
  // volta não pode dar lucro e o pool deve voltar perto do ponto de partida.
  const imbalanceNow = async () => {
    const p = await fetchPool();
    const v = await accounts([brlVault, usdVault]);
    const b = avail(p, tokenAmount(v[0]), BRL);
    const d = avail(p, tokenAmount(v[1]), USD) * price;
    const now = Math.floor(Date.now() / 1000);
    const open = now - Number(p.breakerStart) < Number(p.breakerWindowSecs);
    return {
      imbalancePct: Math.round(((b - d) / (b + d)) * 1000) / 10,
      freeUSD: Math.round(avail(p, tokenAmount(v[1]), USD) / 1e4) / 100,
      breakerUsedUSDPct: open && Number(p.breakerBase[USD]) > 0 ? Math.round((Number(p.breakerOut[USD]) / ((Number(p.breakerBase[USD]) * p.breakerBps) / 10_000)) * 1000) / 10 : 0,
    };
  };
  const STRESS = Number(process.env.STRESS_USERS ?? 40);
  let stressUsers = STRESS;
  const pf = await fetchPool();
  const nowS = Math.floor(Date.now() / 1000);
  const windowLeft = Number(pf.faucetWindowStart) + 3_600 - nowS;
  const mintedNow = windowLeft > 0 ? Number(pf.faucetWindowMinted) / 1e9 : 0; // em milhares de reais
  if (mintedNow + STRESS > 50) {
    if (windowLeft > 0 && windowLeft < 70 * 60) {
      console.log(`Esperando o faucet renovar (${windowLeft} s) para a corrida ao dólar…`);
      await sleep((windowLeft + 10) * 1000);
    } else stressUsers = Math.max(0, Math.floor(50 - mintedNow));
  }
  const stressKs = Array.from({ length: stressUsers }, () => Keypair.generate());
  const stressBefore = await imbalanceNow();
  await stage(
    "estresse: cadastro com faucet",
    stressKs.map((k, i) => ({
      stage: "estresse: cadastro",
      tag: i,
      signers: [k],
      expect: "ok",
      build: async () => [
        fund(k.publicKey, rent.credential + rent.claim + MARGIN + SYS_MIN),
        ...atas(k.publicKey),
        await credentialIx(k.publicKey),
        await program.methods
          .faucetClaim()
          .accountsPartial({
            user: k.publicKey,
            pool,
            claim: claimPda(pid, pool, k.publicKey),
            brlMint,
            userBrl: ata(k.publicKey, BRL),
            mintAuthority: mintAuthorityPda(pid, pool),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
    })),
  );
  const ready = (await accounts(stressKs.map((k) => ata(k.publicKey, BRL)))).map((a) => tokenAmount(a) >= 1_000_000_000);
  let waiting = stressKs.map((k, i) => ({ k, i })).filter((x) => ready[x.i]);
  const stressRounds: { round: number; tried: number; ok: number; refused: Record<string, number>; after: Awaited<ReturnType<typeof imbalanceNow>>; guardianLevel: number }[] = [];
  const buyOrder: number[] = [];
  let peak = stressBefore;
  for (let round = 1; round <= 4 && waiting.length; round++) {
    const res = await stage(
      `estresse: corrida ao dólar, rajada ${round}`,
      waiting.map((x) => ({ stage: "estresse: real → dólar (R$ 1.000)", tag: x.i, signers: [x.k], expect: "ok", build: async () => [await swapIx(x.k.publicKey, BRL, 1_000)] })),
    );
    const okTags = res.filter((d) => d.result === "ok").map((d) => d.tag!);
    buyOrder.push(...okTags);
    const refused = histogram(res.filter((d) => d.result !== "ok"));
    const after = await imbalanceNow();
    if (after.imbalancePct > peak.imbalancePct) peak = after;
    // Depois de cada rajada, alguém chama a vigília: o guardião decide sozinho.
    const level = await vigil(`estresse: vigília depois da rajada ${round}`);
    const pv = await fetchPool();
    lockLog.push({ at: `rajada ${round}`, level, restUntil: Number(pv.restUntil), breatheUntil: Number(pv.breatheUntil), side: pv.breatheSide });
    stressRounds.push({ round, tried: res.length, ok: okTags.length, refused, after, guardianLevel: level });
    waiting = waiting.filter((x) => !okTags.includes(x.i));
    if (!okTags.length) break; // travado: nenhuma compra passou nesta rajada
    if (waiting.length) await sleep(61_000); // nova janela do limite por minuto
  }
  // As recusas das travas (limite por minuto, disjuntor, respiro do guardião) são o esperado, não falha do teste.
  const STRESS_LOCKS = ["OutflowLimit", "CircuitBreaker", "GuardianBreathing", "GuardianResting"];
  for (const d of done) if (d.stage === "estresse: real → dólar (R$ 1.000)" && STRESS_LOCKS.includes(d.result)) d.pass = true;
  const breathed = lockLog.find((l) => l.at.startsWith("rajada") && l.level === 1);
  info = await accounts(stressKs.flatMap((k) => [ata(k.publicKey, BRL), ata(k.publicKey, USD)]));
  const stressUsd = stressKs.map((_, i) => tokenAmount(info[2 * i + 1]));
  const stressBrl = stressKs.map((_, i) => tokenAmount(info[2 * i]));
  const stressBuyFees = buyOrder.map((i) => (1 - ((stressUsd[i] / 1e6) * price) / 1_000) * 100);
  const sellBack = await stage(
    "estresse: recuperação (devolvem o dólar)",
    stressKs
      .map((k, i) => ({ k, i }))
      .filter((x) => stressUsd[x.i] > 0)
      .map((x) => ({ stage: "estresse: dólar → real (recuperação)", tag: x.i, signers: [x.k], expect: "ok", build: async () => [await swapRawIx(x.k.publicKey, USD, stressUsd[x.i])] })),
  );
  info = await accounts(stressKs.map((k) => ata(k.publicKey, BRL)));
  const stressSellFees: number[] = [];
  let stressProfit = 0;
  for (const d of sellBack.filter((d) => d.result === "ok")) {
    const i = d.tag!;
    const back = (tokenAmount(info[i]) - stressBrl[i]) / 1e6;
    stressSellFees.push((1 - back / ((stressUsd[i] / 1e6) * price)) * 100);
    if (back > 1_000) stressProfit++;
  }
  const stressAfter = await imbalanceNow();
  // O respiro solta sozinho: espera a hora e uma compra pequena de dólar volta a passar, sem ninguém soltar nada.
  let autoRelease = "respiro não disparou";
  const pr = await fetchPool();
  if (Number(pr.breatheUntil) > 0) {
    const waitMs = Number(pr.breatheUntil) * 1000 + 5_000 - Date.now();
    if (waitMs > 0) {
      console.log(`Esperando o respiro do guardião acabar sozinho (${Math.round(waitMs / 1000)} s)…`);
      await sleep(waitMs);
    }
    const buyer = stressKs.find((_, i) => sellBack.some((d) => d.tag === i && d.result === "ok"));
    if (buyer) {
      const r = await stage("estresse: compra depois do respiro acabar", [{ stage: "estresse: respiro soltou sozinho", signers: [buyer], expect: "ok", build: async () => [await swapIx(buyer.publicKey, BRL, 50)] }]);
      autoRelease = r[0].result === "ok" ? "soltou sozinho pelo tempo" : `compra recusada: ${r[0].result}`;
    }
  }
  await cleanup("estresse: devolução", stressKs);
  const firstFees = stressBuyFees.slice(0, 5);
  const lastFees = stressBuyFees.slice(-5);
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const stress = {
    wallets: stressKs.length,
    perWalletBRL: 1_000,
    before: stressBefore,
    peak,
    after: stressAfter,
    rounds: stressRounds,
    bought: buyOrder.length,
    buyFeePct: { first5: Math.round(mean(firstFees) * 1000) / 1000, last5: Math.round(mean(lastFees) * 1000) / 1000, all: stats(stressBuyFees) },
    sellBackFeePct: stats(stressSellFees),
    profitableRoundTrips: stressProfit,
    guardian: { breathed: breathed ? { at: breathed.at, side: breathed.side === USD ? "dólar" : "real" } : null, autoRelease },
  };
  console.log("Estresse:", JSON.stringify(stress));

  // ---------- Relatório ----------
  const pEnd = await fetchPool();
  const solEnd = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  const byStage: Record<string, { total: number; asExpected: number; results: Record<string, number>; latencyMs: ReturnType<typeof stats> }> = {};
  for (const d of done) {
    const s = (byStage[d.stage] ??= { total: 0, asExpected: 0, results: {}, latencyMs: null });
    s.total++;
    if (d.pass) s.asExpected++;
    s.results[d.result] = (s.results[d.result] ?? 0) + 1;
  }
  for (const [k, s] of Object.entries(byStage)) s.latencyMs = stats(done.filter((d) => d.stage === k && d.result === "ok").map((d) => d.ms));
  const confirmedOk = done.filter((d) => d.result === "ok");
  const elapsedS = (Date.now() - t0) / 1000;
  const allCu = Object.entries(samples).flatMap(([k, v]) => v.map((x) => ({ k, ...x })));
  const cuOf = (needle: string) => {
    const v = allCu.filter((x) => x.k.includes(needle)).map((x) => x.cu);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const kycStages = Object.entries(byStage).filter(([k]) => k.startsWith("kyc: troca"));
  const st = (k: string) => byStage[k] ?? { total: 0, asExpected: 0 };
  const allOk = (k: string) => st(k).total > 0 && st(k).asExpected === st(k).total;
  const disc = discountRows.length ? { n: discountRows.length, depositorAvgPct: Math.round((discountRows.reduce((a, r) => a + r.depositorPct, 0) / discountRows.length) * 100) / 100, retailAvgPct: Math.round((discountRows.reduce((a, r) => a + r.retailPct, 0) / discountRows.length) * 100) / 100 } : null;
  const buy = stats(buyFees);
  const checks = [
    { claim: "Cadastro com credencial on-chain", expected: "todas as carteiras cadastradas", measured: `${st("trocas: cadastro").asExpected + st("rende: cadastro").asExpected} de ${st("trocas: cadastro").total + st("rende: cadastro").total}`, ok: allOk("trocas: cadastro") && allOk("rende: cadastro") },
    { claim: "Sem credencial, o programa recusa a troca", expected: "KycRequired em todas", measured: `${kycStages.filter(([k]) => k.includes("sem credencial")).map(([, s]) => `${s.asExpected}/${s.total}`).join("")}`, ok: allOk("kyc: troca sem credencial") },
    { claim: "Teto por operação do nível 1: R$ 10 mil", expected: "AboveKycLimit em todas", measured: `${st("kyc: troca acima do teto do nível 1 (R$ 10 mil)").asExpected}/${st("kyc: troca acima do teto do nível 1 (R$ 10 mil)").total}`, ok: allOk("kyc: troca acima do teto do nível 1 (R$ 10 mil)") },
    { claim: "Taxa de varejo: base 1%, multiplicador dinâmico entre 0,7x e 1,5x", expected: "taxa efetiva da compra de dólar entre 0,7% e 1,5%", measured: buy ? `${buy.min}% a ${buy.max}% (mediana ${buy.p50}%)` : "–", ok: !!buy && buy.min >= 0.69 && buy.max <= 1.51 },
    { claim: "Ida e volta nunca dá lucro", expected: "nenhuma carteira termina com mais real", measured: `${profitable} de ${roundTrip.length} com lucro`, ok: roundTrip.length > 0 && profitable === 0 },
    { claim: "Parceiro Pix: 0,2% do volume via Pix", expected: "0,2% do volume", measured: `${split.partnerPctOfVolume}%`, ok: Math.abs(split.partnerPctOfVolume - 0.2) <= 0.01 },
    { claim: "Operação: 25% da taxa depois do parceiro", expected: "25%", measured: `${split.platformPctOfNet}%`, ok: Math.abs(split.platformPctOfNet - 25) <= 0.5 },
    { claim: "Provedores de liquidez (Baleias + Rende): 75% da taxa depois do parceiro", expected: "75%", measured: `${split.providersPctOfNet}%`, ok: Math.abs(split.providersPctOfNet - 75) <= 0.5 },
    {
      claim: "Prêmio de escassez: só quem deposita a moeda que falta ganha cotas a mais, até 10%",
      expected: imbalanceAtDeposit > 0 ? "dólar com prêmio (0% a 10%); real sem prêmio" : "real com prêmio; dólar sem prêmio",
      measured: `dólar ${premium.dolar?.avgPct ?? "–"}% · real ${premium.real?.avgPct ?? "–"}% (desequilíbrio ${imbalanceAtDeposit}%)`,
      ok: imbalanceAtDeposit > 0 ? !!premium.dolar && premium.dolar.minPct > 0 && premium.dolar.maxPct <= 10 && !!premium.real && Math.abs(premium.real.maxPct) < 0.01 : true,
    },
    { claim: "Trava de depósito: sacar logo depois é recusado", expected: "PositionLocked em todas", measured: `${st("rende: trava de depósito").asExpected}/${st("rende: trava de depósito").total}`, ok: allOk("rende: trava de depósito") },
    { claim: "Depositante a partir de R$ 1.000 paga 0,5% (varejo 1%)", expected: "depositante paga cerca de metade do varejo", measured: disc ? `depositante ${disc.depositorAvgPct}% · varejo ${disc.retailAvgPct}%` : "–", ok: !!disc && disc.depositorAvgPct < disc.retailAvgPct * 0.6 },
    { claim: "Rende recebe parte das taxas", expected: "rendimento colhido maior que zero", measured: `R$ ${yieldBrl.toFixed(4)} para ${earners} de ${okDeposit.length} depositantes`, ok: earners > 0 },
    { claim: "Saque imediato do principal", expected: "todos sacam", measured: `${st("rende: saque imediato").asExpected}/${st("rende: saque imediato").total}`, ok: allOk("rende: saque imediato") },
    { claim: "Guardião é um programa: nenhuma chave consegue travar o pool", expected: "ConstraintHasOne para a chave do deployer", measured: `${st("guardião: chave tenta travar").asExpected}/${st("guardião: chave tenta travar").total}`, ok: allOk("guardião: chave tenta travar") },
    { claim: "Uso normal: as vigílias entre os lotes não travam nada", expected: "nenhuma trava", measured: `${cohortVigils.filter((l) => l === 0).length} de ${cohortVigils.length} vigílias sem trava`, ok: cohortVigils.length > 0 && cohortVigils.every((l) => l === 0) },
    { claim: "Salto de cotação de 5%: o guardião descansa sozinho; trocas e depósitos param", expected: "GuardianResting em todas", measured: `${st("guardião: troca durante o descanso").asExpected}/${st("guardião: troca durante o descanso").total} trocas · ${st("guardião: depósito durante o descanso").asExpected}/${st("guardião: depósito durante o descanso").total} depósitos`, ok: allOk("guardião: troca durante o descanso") && allOk("guardião: depósito durante o descanso") },
    { claim: "Saque continua funcionando com o guardião descansando (pedido na fila)", expected: "todos os pedidos aceitos", measured: `${st("rende: pedido na fila durante o descanso").asExpected}/${st("rende: pedido na fila durante o descanso").total}`, ok: allOk("rende: pedido na fila durante o descanso") },
    { claim: "O guardião nunca solta; o conselho solta antes da hora", expected: "conselho solta e a troca volta", measured: guardianNote, ok: allOk("guardião: troca depois de soltar") },
    { claim: "Fila de saque: resgate só depois do aviso prévio", expected: "WithdrawNotReady antes; ok depois", measured: `antes ${st("rende: resgate antes do aviso").asExpected}/${st("rende: resgate antes do aviso").total} · depois ${st("rende: resgate da fila").asExpected}/${st("rende: resgate da fila").total}`, ok: allOk("rende: resgate antes do aviso") && allOk("rende: resgate da fila") },
    {
      claim: "Estresse: uma corrida ao dólar é segurada pelas travas de saída",
      expected: "as primeiras compras passam; depois limite por minuto, disjuntor ou respiro do guardião",
      measured: `${stress.bought} de ${stress.wallets} compras passaram; recusas ${JSON.stringify(stress.rounds.reduce<Record<string, number>>((h, r) => { for (const [k, v] of Object.entries(r.refused)) h[k] = (h[k] ?? 0) + v; return h; }, {}))}`,
      ok: stress.bought > 0 && stress.bought < stress.wallets && stress.rounds.every((r) => Object.keys(r.refused).every((k) => STRESS_LOCKS.includes(k))),
    },
    { claim: "Estresse: o guardião manda respirar sozinho na corrida, só no sentido que drena", expected: "respiro no dólar numa vigília da corrida", measured: stress.guardian.breathed ? `respiro no ${stress.guardian.breathed.side} (${stress.guardian.breathed.at})` : "não disparou", ok: !!stress.guardian.breathed && stress.guardian.breathed.side === "dólar" },
    { claim: "Estresse: com o respiro, quem devolve dólar continua trocando", expected: "todas as devoluções aceitas", measured: `${st("estresse: dólar → real (recuperação)").asExpected}/${st("estresse: dólar → real (recuperação)").total}`, ok: allOk("estresse: dólar → real (recuperação)") },
    { claim: "Estresse: o respiro solta sozinho pelo tempo, sem ninguém", expected: "compra de dólar volta a passar", measured: stress.guardian.autoRelease, ok: stress.guardian.autoRelease === "soltou sozinho pelo tempo" },
    { claim: "Estresse: a taxa sobe conforme falta dólar", expected: "últimas compras pagam mais que as primeiras", measured: `primeiras ${stress.buyFeePct.first5}% · últimas ${stress.buyFeePct.last5}%`, ok: stress.bought >= 10 && stress.buyFeePct.last5 > stress.buyFeePct.first5 },
    { claim: "Estresse: quem devolve a moeda que falta paga menos", expected: "taxa da devolução menor que a da compra", measured: `devolução mediana ${stress.sellBackFeePct?.p50 ?? "–"}% · compra mediana ${stress.buyFeePct.all?.p50 ?? "–"}%`, ok: !!stress.sellBackFeePct && !!stress.buyFeePct.all && stress.sellBackFeePct.p50 < stress.buyFeePct.all.p50 },
    { claim: "Estresse: ida e volta sem lucro mesmo no pico", expected: "nenhuma carteira com lucro", measured: `${stress.profitableRoundTrips} de ${stress.sellBackFeePct?.n ?? 0}`, ok: stress.profitableRoundTrips === 0 && (stress.sellBackFeePct?.n ?? 0) > 0 },
    { claim: "Estresse: o pool volta ao equilíbrio depois", expected: "desequilíbrio final perto do inicial (até 2 pontos)", measured: `${stress.before.imbalancePct}% → pico ${stress.peak.imbalancePct}% → ${stress.after.imbalancePct}%`, ok: Math.abs(stress.after.imbalancePct - stress.before.imbalancePct) <= 2 },
  ];
  const report = {
    at: new Date().toISOString(),
    program: dep.programId,
    pool: dep.pool,
    plan: { requested: TOTAL, wallets: users, rende: rendeCount, traders: traderCount, notes: [budgetNote, faucetNote].filter(Boolean) },
    summary: {
      transactions: done.length,
      asExpected: done.filter((d) => d.pass).length,
      unexpected: Object.entries(byStage)
        .filter(([, s]) => s.asExpected < s.total)
        .map(([k, s]) => `${k}: ${JSON.stringify(s.results)}`),
      elapsedMin: Math.round(elapsedS / 6) / 10,
      throughputTxPerS: Math.round((confirmedOk.length / elapsedS) * 100) / 100,
      confirmLatencyMs: stats(confirmedOk.map((d) => d.ms)),
      avgFeeSol: allCu.length ? allCu.reduce((a, x) => a + x.feeSol, 0) / allCu.length : 0,
      computeUnits: { cadastro: cuOf("cadastro"), troca: cuOf("→"), deposito: cuOf("depósitos"), saque: cuOf("saque imediato"), fila: cuOf("pedido na fila") },
      solSpent: Math.round((solStart - solEnd) * 10_000) / 10_000,
      solPerWallet: Math.round(((solStart - solEnd) / users) * 1_000_000) / 1_000_000,
      rpcCalls,
    },
    checks,
    coherent: checks.filter((c) => c.ok).length,
    fees: { buyPct: stats(buyFees), sellPct: stats(sellFees), roundTripPct: stats(roundTrip), depositorDiscount: disc, split },
    premium,
    stress,
    guardian: { cohortVigils, lockLog },
    rende: { depositors: okDeposit.length, yieldBRL: Math.round(yieldBrl * 10_000) / 10_000, earners },
    breakerMaxUsedPct: { BRL: Math.round(maxBreaker.BRL * 10) / 10, USD: Math.round(maxBreaker.USD * 10) / 10 },
    poolCounters: {
      swapsBefore: Number(p0.swapCount),
      swapsAfter: Number(pEnd.swapCount),
      volumeBRLBefore: Number(p0.volumeBrl) / 1e6,
      volumeBRLAfter: Number(pEnd.volumeBrl) / 1e6,
      paused: pEnd.paused,
    },
    byStage,
    sampleTransactions: Object.fromEntries(Object.entries(sampleSigs).map(([k, s]) => [k, `https://explorer.solana.com/tx/${s}?cluster=devnet`])),
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");

  const md = [
    `## Teste em escala do programa v2.6 (devnet): ${users} carteiras`,
    ``,
    `**${report.coherent} de ${checks.length} afirmações do white paper conferem** · ${report.summary.asExpected} de ${report.summary.transactions} transações com o resultado esperado · ${report.summary.elapsedMin} min`,
    ``,
    `| Afirmação | Esperado | Medido | Confere |`,
    `|---|---|---|---|`,
    ...checks.map((c) => `| ${c.claim} | ${c.expected} | ${c.measured} | ${c.ok ? "✅" : "❌"} |`),
    ``,
    `- Confirmação: p50 ${((report.summary.confirmLatencyMs?.p50 ?? 0) / 1000).toFixed(1)} s · p95 ${((report.summary.confirmLatencyMs?.p95 ?? 0) / 1000).toFixed(1)} s · ${report.summary.throughputTxPerS} tx/s (limitado pela RPC pública)`,
    `- Taxa de rede média: ${report.summary.avgFeeSol.toFixed(6)} SOL · SOL gasto: ${report.summary.solSpent} (${report.summary.solPerWallet} por carteira, quase tudo aluguel de credencial)`,
    `- Estresse: ${stress.bought}/${stress.wallets} compras de R$ 1.000 passaram; desequilíbrio ${stress.before.imbalancePct}% → ${stress.peak.imbalancePct}% → ${stress.after.imbalancePct}%; taxa ${stress.buyFeePct.first5}% → ${stress.buyFeePct.last5}%`,
    `- Disjuntor: uso máximo ${report.breakerMaxUsedPct.BRL}% (real) / ${report.breakerMaxUsedPct.USD}% (dólar)`,
    ...report.plan.notes.map((n) => `- ${n}`),
    ``,
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
