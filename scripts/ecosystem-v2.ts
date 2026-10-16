// Teste de ecossistema do programa v2 na devnet (branch v2): usuários de teste usam o pool de verdade e tudo é medido.
//
// Cenários (cada um vira uma linha do relatório, com sucesso, tempo de confirmação, taxa de rede e compute units):
//   1. Cadastro: credencial de teste + moedas do faucet numa transação.
//   2. Portão de KYC: carteira sem credencial tenta trocar e precisa ser recusada.
//   3. Trocas nos dois sentidos, com a taxa efetiva medida pelos saldos.
//   4. Rende: depósito, saque imediato pequeno, saque grande recusado e pedido na fila de saque.
//   5. Guardião pausa o pool, a troca é recusada, e a multisig das Baleias (7 de 10) despausa.
// No fim: estado do pool (liquidez, desequilíbrio, uso do disjuntor, valor na fila) antes e depois.
//
// Uso (GitHub Actions): ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/ecosystem-v2.ts
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import idl from "../idl/cambi_pool_v2.json";
import { BRL, RENDE, USD, claimPda, credentialPda, mintAuthorityPda, positionPda, ticketPda, u } from "./common";

const RPC = "https://api.devnet.solana.com";
const DEPLOYMENT = "deployments/devnet-v2.json";
const REPORT = "deployments/ecosystem-v2-report.json";
const KEYS = ".consortium-keys";
const USERS = Number(process.env.ECO_USERS ?? 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ---------- RPC educada (a devnet pública limita requisições) ----------
let lastCall = 0;
async function slowFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 600 - Date.now();
    lastCall = Math.max(Date.now(), lastCall + 600);
    if (wait > 0) await sleep(wait);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 25) return res;
    await sleep(Math.min(3_000 * attempt, 30_000));
  }
}
const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: slowFetch as typeof fetch });

interface Step {
  scenario: string;
  name: string;
  expect: "ok" | string; // "ok" ou o código de erro esperado
  result: "ok" | string;
  pass: boolean;
  ms: number;
  feeSol?: number;
  computeUnits?: number;
  signature?: string;
  note?: string;
}
const steps: Step[] = [];

/** Envia e confirma por consulta. Devolve assinatura, tempo e erro do programa (se houver). */
async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const t0 = Date.now();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const seen = new Set<string>();
  tx.sign(...signers.filter((s) => !seen.has(s.publicKey.toBase58()) && seen.add(s.publicKey.toBase58())));
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (e) {
    // Recusa na simulação: é assim que os erros esperados (KYC, pausa, fila) aparecem.
    const logs: string[] = (e as { logs?: string[] }).logs ?? [];
    const msg = [String((e as Error).message), ...logs].join("\n");
    const code = msg.match(/Error Code: (\w+)/)?.[1] ?? msg.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? "erro";
    return { sig: undefined, ms: Date.now() - t0, error: code };
  }
  for (let i = 0; i < 60; i++) {
    await sleep(1_500);
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) return { sig, ms: Date.now() - t0, error: JSON.stringify(st.err) };
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return { sig, ms: Date.now() - t0, error: undefined };
  }
  return { sig, ms: Date.now() - t0, error: "sem confirmação" };
}

/** Executa um passo do teste, mede e registra (passa se o resultado for o esperado). */
async function step(scenario: string, name: string, ixs: TransactionInstruction[], signers: Keypair[], expect: "ok" | string = "ok", note?: string) {
  const r = await send(ixs, signers);
  const result = r.error ?? "ok";
  const s: Step = { scenario, name, expect, result, pass: expect === "ok" ? result === "ok" : result.includes(expect), ms: r.ms, signature: r.sig, note };
  if (r.sig && !r.error) {
    const t = await connection.getTransaction(r.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    s.feeSol = (t?.meta?.fee ?? 0) / LAMPORTS_PER_SOL;
    s.computeUnits = t?.meta?.computeUnitsConsumed ?? undefined;
  }
  steps.push(s);
  console.log(`${s.pass ? "✓" : "✗"} [${scenario}] ${name}: ${result}${expect !== "ok" ? ` (esperado ${expect})` : ""} · ${(s.ms / 1000).toFixed(1)} s${s.computeUnits ? ` · ${s.computeUnits} CU` : ""}`);
  return s;
}

async function main() {
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const program = new Program(idl as Idl, new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" }));
  const pid = program.programId;
  if (pid.toBase58() !== dep.programId) throw new Error("IDL v2 não corresponde ao programa implantado");
  const pool = new PublicKey(dep.pool);
  const brlMint = new PublicKey(dep.brlMint);
  const usdMint = new PublicKey(dep.usdMint);
  const brlVault = new PublicKey(dep.brlVault);
  const usdVault = new PublicKey(dep.usdVault);
  const msPda = new PublicKey(dep.consortium.multisig);
  const vault = new PublicKey(dep.consortium.vault);
  const acc = program.account as any;
  const ata = (owner: PublicKey, side: number) => getAssociatedTokenAddressSync(side === BRL ? brlMint : usdMint, owner);

  const snapshot = async () => {
    const p = await acc.pool.fetch(pool);
    const [vb, vu] = await Promise.all([connection.getTokenAccountBalance(brlVault), connection.getTokenAccountBalance(usdVault)]);
    const price = Number(p.price.toString()) / 1e6;
    const reserved = (s: number) => (Number(p.platformFees[s]) + Number(p.partnerFees[s]) + Number(p.lpFeesUnclaimed[s]) + Number(p.queued[s])) / 1e6;
    const freeBrl = Number(vb.value.uiAmount) - reserved(BRL);
    const freeUsd = Number(vu.value.uiAmount) - reserved(USD);
    const now = Math.floor(Date.now() / 1000);
    const windowOpen = now - Number(p.breakerStart) < Number(p.breakerWindowSecs);
    const used = (s: number) => (windowOpen && Number(p.breakerBase[s]) > 0 ? Number(p.breakerOut[s]) / ((Number(p.breakerBase[s]) * p.breakerBps) / 10_000) : 0);
    return {
      at: new Date().toISOString(),
      price,
      paused: p.paused,
      freeBRL: Math.round(freeBrl * 100) / 100,
      freeUSD: Math.round(freeUsd * 100) / 100,
      tvlBRL: Math.round((freeBrl + freeUsd * price) * 100) / 100,
      imbalance: Math.round(((freeBrl - freeUsd * price) / (freeBrl + freeUsd * price)) * 1000) / 10, // % (positivo = sobra real)
      breakerUsedPct: { BRL: Math.round(used(BRL) * 1000) / 10, USD: Math.round(used(USD) * 1000) / 10 },
      queued: { BRL: Number(p.queued[BRL]) / 1e6, USD: Number(p.queued[USD]) / 1e6 },
      swapCount: Number(p.swapCount),
      volumeBRL: Number(p.volumeBrl) / 1e6,
    };
  };

  const before = await snapshot();
  console.log("Pool antes:", before);
  const solBefore = (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL;

  // ---------- Usuários de teste (chaves descartáveis, nunca salvas) ----------
  const users = Array.from({ length: USERS }, () => Keypair.generate());
  const outsider = Keypair.generate();
  await step(
    "preparo",
    `SOL de taxas para ${USERS + 1} carteiras de teste`,
    [...users, outsider].map((k) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: k.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })),
    [admin],
  );

  const credentialIx = (k: Keypair) =>
    program.methods.devnetCredential().accountsPartial({ user: k.publicKey, pool, credential: credentialPda(pid, pool, k.publicKey), systemProgram: SystemProgram.programId }).instruction();
  const faucetIx = (k: Keypair) =>
    program.methods
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
      .instruction();
  const ataIxs = (k: Keypair) => [
    createAssociatedTokenAccountIdempotentInstruction(k.publicKey, ata(k.publicKey, BRL), k.publicKey, brlMint),
    createAssociatedTokenAccountIdempotentInstruction(k.publicKey, ata(k.publicKey, USD), k.publicKey, usdMint),
  ];
  const swapIx = (k: Keypair, side: number, amount: number, withCredential = true) =>
    program.methods
      .swap(side, u(amount), u(0))
      .accountsPartial({
        user: k.publicKey,
        pool,
        brlVault,
        usdVault,
        userBrl: ata(k.publicKey, BRL),
        userUsd: ata(k.publicKey, USD),
        depositorPosition: null,
        partner: null,
        credential: withCredential ? credentialPda(pid, pool, k.publicKey) : null,
        brlMint,
        usdMint,
        brlReserve: null,
        usdReserve: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const balance = async (k: Keypair, side: number) => Number((await connection.getTokenAccountBalance(ata(k.publicKey, side))).value.uiAmount ?? 0);

  // 1. Cadastro
  for (const [i, k] of users.entries()) {
    await step("cadastro", `Usuário ${i + 1}: credencial de teste + R$ 1.000 do faucet`, [...ataIxs(k), await credentialIx(k), await faucetIx(k)], [k]);
  }

  // 2. Portão de KYC
  await step("kyc", "Carteira sem credencial: contas de token + faucet", [...ataIxs(outsider), await faucetIx(outsider)], [outsider]);
  await step("kyc", "Carteira sem credencial tenta trocar", [await swapIx(outsider, BRL, 100, false)], [outsider], "KycRequired");

  // 3. Trocas nos dois sentidos, com taxa efetiva medida pelos saldos
  const effective: { user: number; side: string; amountIn: number; out: number; feePct: number }[] = [];
  const price = before.price;
  for (const [i, k] of users.entries()) {
    const amount = 100 + ((i * 137) % 600); // R$ 100 a R$ 700
    const usd0 = await balance(k, USD);
    const s = await step("trocas", `Usuário ${i + 1}: R$ ${amount} → dólar`, [await swapIx(k, BRL, amount)], [k]);
    if (s.pass) {
      const out = (await balance(k, USD)) - usd0;
      effective.push({ user: i + 1, side: "BRL→USD", amountIn: amount, out, feePct: Math.round((1 - (out * price) / amount) * 10_000) / 100 });
    }
  }
  for (const [i, k] of users.slice(0, Math.ceil(USERS / 2)).entries()) {
    const usd = Math.floor((await balance(k, USD)) * 50) / 100; // metade do dólar de volta
    if (usd <= 1) continue;
    const brl0 = await balance(k, BRL);
    const s = await step("trocas", `Usuário ${i + 1}: US$ ${usd} → real`, [await swapIx(k, USD, usd)], [k]);
    if (s.pass) {
      const out = (await balance(k, BRL)) - brl0;
      effective.push({ user: i + 1, side: "USD→BRL", amountIn: usd, out, feePct: Math.round((1 - out / (usd * price)) * 10_000) / 100 });
    }
  }

  // 4. Rende: depósito, saque imediato pequeno, saque grande vai para a fila
  const saver = users[users.length - 1];
  const position = positionPda(pid, pool, saver.publicKey, RENDE, BRL);
  const depositAmount = Math.floor((await balance(saver, BRL)) - 1);
  await step(
    "rende",
    `Depósito na Rende: R$ ${depositAmount}`,
    [
      await program.methods
        .deposit(RENDE, BRL, u(depositAmount))
        .accountsPartial({
          user: saver.publicKey,
          pool,
          position,
          brlVault,
          usdVault,
          userBrl: ata(saver.publicKey, BRL),
          userUsd: ata(saver.publicKey, USD),
          credential: credentialPda(pid, pool, saver.publicKey),
          brlMint,
          usdMint,
          brlReserve: null,
          usdReserve: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ],
    [saver],
  );
  const withdrawIx = (amount: number) =>
    program.methods
      .withdraw(u(amount))
      .accountsPartial({ user: saver.publicKey, pool, position, brlVault, usdVault, userBrl: ata(saver.publicKey, BRL), userUsd: ata(saver.publicKey, USD), tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
  // A trava de depósito (lockup) segura o principal por alguns minutos: o teste espera para medir o saque de verdade.
  const lockup = Number((await acc.pool.fetch(pool)).lockupSecs);
  await step("rende", "Saque logo após depositar (trava de depósito)", [await withdrawIx(10)], [saver], "PositionLocked");
  console.log(`Esperando a trava de depósito (${lockup} s)…`);
  await sleep((lockup + 5) * 1000);
  await step("rende", "Colher rendimento (saque zero)", [await withdrawIx(0)], [saver]);
  await step("rende", "Saque imediato pequeno (R$ 10)", [await withdrawIx(10)], [saver]);
  const big = depositAmount - 10;
  const free = (await snapshot()).freeBRL;
  const bigIsLarge = big > free * 0.1;
  await step("rende", `Saque imediato de R$ ${big}`, [await withdrawIx(big)], [saver], bigIsLarge ? "UseWithdrawQueue" : "ok", bigIsLarge ? "acima de 10% da liquidez livre" : "abaixo de 10%: sai na hora");
  if (bigIsLarge) {
    await step(
      "rende",
      `Pedido na fila de saque: R$ ${big}`,
      [
        await program.methods
          .requestWithdraw(u(big))
          .accountsPartial({
            user: saver.publicKey,
            pool,
            position,
            ticket: ticketPda(pid, position),
            brlVault,
            usdVault,
            userBrl: ata(saver.publicKey, BRL),
            userUsd: ata(saver.publicKey, USD),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      [saver],
    );
  }

  // 5. Guardião pausa; troca recusada; multisig despausa (7 de 10)
  const guardian = (await acc.pool.fetch(pool)).guardian as PublicKey;
  if (guardian.equals(admin.publicKey) && existsSync(KEYS)) {
    const members = Array.from({ length: 10 }, (_, i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${KEYS}/baleia-${i + 1}.json`, "utf8")))));
    await step("guardiao", "Guardião de plantão pausa o pool", [await program.methods.guardianPause().accountsPartial({ guardian: admin.publicKey, pool }).instruction()], [admin]);
    await step("guardiao", "Troca com o pool pausado", [await swapIx(users[0], BRL, 50)], [users[0]], "Paused");
    await step("guardiao", "Guardião tenta despausar (não pode)", [await program.methods.setPaused(false).accountsPartial({ admin: admin.publicKey, pool }).instruction()], [admin], "ConstraintHasOne");
    // Despausar é da multisig: proposta, 7 aprovações, execução.
    const t0 = Date.now();
    let unpaused = false;
    for (let attempt = 1; attempt <= 3 && !unpaused; attempt++) {
      try {
        const ix = await program.methods.setPaused(false).accountsPartial({ admin: vault, pool }).instruction();
        const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
        const transactionIndex = BigInt(Number(info.transactionIndex) + 1);
        const signers = members.slice().sort(() => Math.random() - 0.5).slice(0, 7);
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const a = await send(
          [
            multisig.instructions.vaultTransactionCreate({
              multisigPda: msPda,
              transactionIndex,
              creator: signers[0].publicKey,
              vaultIndex: 0,
              ephemeralSigners: 0,
              transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [ix] }),
              memo: "cambI: despausar depois do teste de ecossistema",
            }),
            multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex, creator: signers[0].publicKey }),
          ],
          [signers[0]],
        );
        if (a.error) throw new Error(a.error);
        const b = await send(signers.map((m) => multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex, member: m.publicKey })), signers);
        if (b.error) throw new Error(b.error);
        const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex, member: signers[0].publicKey });
        const c = await send([instruction], [signers[0]]);
        if (c.error) throw new Error(c.error);
        steps.push({ scenario: "guardiao", name: "Multisig 7 de 10 despausa o pool", expect: "ok", result: "ok", pass: true, ms: Date.now() - t0, signature: c.sig, note: `proposta ${a.sig}; aprovações ${b.sig}` });
        console.log(`✓ [guardiao] Multisig 7 de 10 despausa o pool · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        unpaused = true;
      } catch (e) {
        console.log(`Despausar pela multisig, tentativa ${attempt}: ${(e as Error).message}`);
      }
    }
    if (!unpaused) {
      steps.push({ scenario: "guardiao", name: "Multisig 7 de 10 despausa o pool", expect: "ok", result: "falhou", pass: false, ms: Date.now() - t0 });
    }
    await step("guardiao", "Troca depois de despausar", [await swapIx(users[0], BRL, 50)], [users[0]]);
  }

  // ---------- Relatório ----------
  const after = await snapshot();
  const solAfter = (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL;
  const confirmed = steps.filter((s) => s.signature && s.result === "ok");
  const lat = confirmed.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0);
  const cuBy = (prefix: string) => {
    const v = steps.filter((s) => s.name.includes(prefix) && s.computeUnits).map((s) => s.computeUnits!);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const report = {
    at: new Date().toISOString(),
    program: dep.programId,
    pool: dep.pool,
    users: USERS,
    summary: {
      steps: steps.length,
      passed: steps.filter((s) => s.pass).length,
      failed: steps.filter((s) => !s.pass).map((s) => `${s.scenario}: ${s.name} → ${s.result}`),
      confirmLatencyMs: { p50: pct(50), p95: pct(95), max: lat[lat.length - 1] ?? 0 },
      avgFeeSol: confirmed.length ? confirmed.reduce((a, s) => a + (s.feeSol ?? 0), 0) / confirmed.length : 0,
      computeUnits: { cadastro: cuBy("credencial de teste"), troca: cuBy("→"), deposito: cuBy("Depósito"), filaDeSaque: cuBy("fila de saque") },
      effectiveFeePct: effective,
      solSpentByDeployer: Math.round((solBefore - solAfter) * 10_000) / 10_000,
    },
    poolBefore: before,
    poolAfter: after,
    steps: steps.map((s) => ({ ...s, url: s.signature ? explorer(s.signature) : undefined })),
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");

  const md = [
    `## Teste de ecossistema do programa v2 (devnet)`,
    ``,
    `**${report.summary.passed} de ${report.summary.steps} passos com o resultado esperado** · ${USERS} usuários de teste`,
    ``,
    `- Confirmação: p50 ${(pct(50) / 1000).toFixed(1)} s · p95 ${(pct(95) / 1000).toFixed(1)} s`,
    `- Taxa de rede média: ${report.summary.avgFeeSol.toFixed(6)} SOL por transação`,
    `- Compute units: ${Object.entries(report.summary.computeUnits).map(([k, v]) => `${k} ${v ?? "–"}`).join(" · ")}`,
    `- Taxa efetiva das trocas: ${effective.map((e) => `${e.side} ${e.feePct}%`).join(", ")}`,
    `- Pool: liquidez R$ ${before.tvlBRL.toLocaleString("pt-BR")} → R$ ${after.tvlBRL.toLocaleString("pt-BR")} · desequilíbrio ${before.imbalance}% → ${after.imbalance}% · disjuntor usado ${after.breakerUsedPct.BRL}% (real) / ${after.breakerUsedPct.USD}% (dólar) · na fila R$ ${after.queued.BRL}`,
    ``,
    `| Cenário | Passo | Esperado | Resultado | Tempo |`,
    `|---|---|---|---|---|`,
    ...steps.map((s) => `| ${s.scenario} | ${s.name} | ${s.expect} | ${s.pass ? "✅" : "❌"} ${s.result} | ${(s.ms / 1000).toFixed(1)} s |`),
    ``,
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (report.summary.failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
