// Upgrade GOVERNADO do programa v2: a multisig de upgrade (as mesmas 10 Baleias, 7 de 10) aprova a troca do binário
// e só consegue executar depois do prazo de espera (timelock). Ninguém sozinho atualiza o programa.
//
// Passos: (1) o deployer já gravou o novo binário num buffer e passou a autoridade do buffer para o cofre da
// multisig (workflow); (2) uma Baleia propõe; (3) 7 aprovam; (4) espera o prazo; (5) executa; (6) confere o binário.
//
// Uso (GitHub Actions): BUFFER=<endereço> NEW_SIZE=<bytes> ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/upgrade-v2.ts
//
// Proposta já aprovada e não executada (ex.: a execução falhou depois do prazo): `--pending` confere se ela troca o
// programa por ESTE binário e, se sim, grava PENDING_INDEX e BUFFER no ambiente do workflow; com PENDING_INDEX o
// script só executa (as aprovações e o prazo de espera já valeram na rede).
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { appendFileSync, readFileSync, writeFileSync } from "fs";

const RPC = "https://api.devnet.solana.com";
const FILE = "deployments/devnet-v2.json";
const KEYS = ".consortium-keys";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

let lastCall = 0;
async function slowFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 700 - Date.now();
    lastCall = Math.max(Date.now(), lastCall + 700);
    if (wait > 0) await sleep(wait);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 25) return res;
    await sleep(Math.min(3_000 * attempt, 30_000));
  }
}
const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: slowFetch as typeof fetch });

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const seen = new Set<string>();
  tx.sign(...signers.filter((s) => !seen.has(s.publicKey.toBase58()) && seen.add(s.publicKey.toBase58())));
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Transação falhou ${sig}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`Sem confirmação: ${sig}`);
}

// A execução troca um binário de ~650 KB dentro da chamada da multisig: não cabe no orçamento padrão de 200 mil
// unidades de cálculo.
const EXECUTE_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function errorText(e: unknown, logLines = 0): string {
  const err = e as Error & { logs?: string[]; transactionLogs?: string[] };
  const logs = err.logs ?? err.transactionLogs ?? [];
  const msg = err.message.split("\n")[0].slice(0, 200);
  return logLines && logs.length ? `${msg}\n  ${logs.slice(-logLines).join("\n  ")}` : msg;
}

// Proposta de upgrade aprovada e ainda não executada que grava ESTE binário (target/deploy/cambi_pool.so)?
async function findPending(msPda: PublicKey, vault: PublicKey): Promise<{ index: bigint; buffer: PublicKey } | null> {
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
  const index = BigInt(Number(info.transactionIndex));
  if (index === 0n) return null;
  const [proposalPda] = multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index });
  const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda, "confirmed").catch(() => null);
  if (!proposal || proposal.status.__kind !== "Approved") return null;
  const [txPda] = multisig.getTransactionPda({ multisigPda: msPda, index });
  const vtx = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, txPda, "confirmed");
  const keys = vtx.message.accountKeys;
  const upgrade = vtx.message.instructions.find((ix) => keys[ix.programIdIndex].equals(LOADER) && Buffer.from(ix.data).equals(u32(3)));
  if (!upgrade) return null;
  const buffer = keys[upgrade.accountIndexes[2]];
  const acc = await connection.getAccountInfo(buffer, "confirmed");
  const bin = readFileSync("target/deploy/cambi_pool.so");
  // Buffer: [tipo u32][autoridade: option u8 + pubkey][binário]
  if (!acc || acc.data[4] !== 1 || !new PublicKey(acc.data.subarray(5, 37)).equals(vault)) return null;
  if (!acc.data.subarray(37, 37 + bin.length).equals(bin)) {
    console.log(`Proposta #${index} aprovada, mas o buffer ${buffer.toBase58()} tem outro binário: não será reaproveitada.`);
    return null;
  }
  return { index, buffer };
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

async function main() {
  const dep = JSON.parse(readFileSync(FILE, "utf8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const members = Array.from({ length: 10 }, (_, i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${KEYS}/baleia-${i + 1}.json`, "utf8")))));
  const program = new PublicKey(dep.programId);
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  const buffer = new PublicKey(process.env.BUFFER!);
  const newSize = Number(process.env.NEW_SIZE);
  const msPda = new PublicKey(dep.consortium.upgrade.multisig);
  const vault = new PublicKey(dep.consortium.upgrade.vault);
  const timeLock = Number(dep.consortium.upgrade.timeLockSecs);

  if (process.argv.includes("--pending")) {
    const p = await findPending(msPda, vault);
    if (p) {
      console.log(`Proposta #${p.index} já aprovada para este binário (buffer ${p.buffer.toBase58()}): só falta executar.`);
      if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `PENDING_INDEX=${p.index}\nBUFFER=${p.buffer.toBase58()}\n`);
    } else console.log("Nenhuma proposta pendente para este binário.");
    return;
  }
  if (process.env.PENDING_INDEX) return executePending(dep, msPda, BigInt(process.env.PENDING_INDEX), members, timeLock);

  // Confere: a autoridade de upgrade é o cofre da multisig (senão, não há o que governar).
  const pd = await connection.getAccountInfo(programData, "confirmed");
  if (!pd || pd.data[12] !== 1 || !new PublicKey(pd.data.subarray(13, 45)).equals(vault)) throw new Error("Autoridade de upgrade não é o cofre da multisig");
  const currentLen = pd.data.length - 45;
  console.log(`Programa ${program.toBase58()} · binário atual ${currentLen} bytes · novo ${newSize} bytes`);

  const ixs: TransactionInstruction[] = [];
  const extra = newSize - currentLen;
  if (extra > 0) {
    // Mais espaço para o binário maior: ExtendProgramChecked (autoridade = cofre, que também paga o aluguel).
    const rent = await connection.getMinimumBalanceForRentExemption(extra);
    await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: vault, lamports: rent + 0.01 * LAMPORTS_PER_SOL })], [deployer]);
    ixs.push(
      new TransactionInstruction({
        programId: LOADER,
        keys: [
          { pubkey: programData, isSigner: false, isWritable: true },
          { pubkey: program, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: true, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: vault, isSigner: true, isWritable: true },
        ],
        data: Buffer.concat([u32(9), u32(extra)]),
      }),
    );
  }
  ixs.push(
    new TransactionInstruction({
      programId: LOADER,
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: program, isSigner: false, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: deployer.publicKey, isSigner: false, isWritable: true }, // devolve o aluguel do buffer
        { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: true, isWritable: false },
      ],
      data: u32(3),
    }),
  );

  // Proposta + 7 aprovações.
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
  const transactionIndex = BigInt(Number(info.transactionIndex) + 1);
  const signers = members.slice().sort(() => Math.random() - 0.5).slice(0, 7);
  const proposer = signers[0];
  if ((await connection.getBalance(proposer.publicKey)) < 0.03 * LAMPORTS_PER_SOL) {
    await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: proposer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [deployer]);
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const reason = process.env.REASON ?? "Atualização do programa";
  const createSig = await send(
    [
      multisig.instructions.vaultTransactionCreate({
        multisigPda: msPda,
        transactionIndex,
        creator: proposer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: ixs }),
        memo: `cambI upgrade: ${reason}`.slice(0, 80),
      }),
      multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex, creator: proposer.publicKey }),
    ],
    [proposer],
  );
  console.log(`Proposta de upgrade #${transactionIndex}: ${createSig}`);
  const approveSig = await send(signers.map((m) => multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex, member: m.publicKey })), signers);
  const approvedAt = Date.now();
  console.log(`7 Baleias aprovaram: ${approveSig}. Prazo de espera: ${timeLock / 60} min.`);

  // Antes do prazo, a execução é recusada (prova de que o timelock vale).
  let earlyRefused = false;
  try {
    const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex, member: proposer.publicKey });
    await send([instruction], [proposer]);
  } catch (e) {
    earlyRefused = true;
    console.log(`Execução antes do prazo recusada, como esperado: ${(e as Error).message.slice(0, 120)}`);
  }
  if (!earlyRefused) throw new Error("A execução passou antes do prazo de espera");

  // Espera o prazo e executa.
  await sleep(Math.max(0, approvedAt + (timeLock + 30) * 1000 - Date.now()));
  const executeSig = await execute(msPda, transactionIndex, proposer);

  record(dep, {
    index: Number(transactionIndex),
    action: `Upgrade do programa: ${reason}`,
    at: new Date().toISOString(),
    proposer: proposer.publicKey.toBase58(),
    approvals: signers.map((m) => ({ member: m.publicKey.toBase58(), signature: approveSig })),
    createSignature: createSig,
    executeSignature: executeSig,
    timeLockSecs: timeLock,
    waitedMinutes: Math.round((Date.now() - approvedAt) / 60_000),
    earlyExecutionRefused: earlyRefused,
  }, approveSig);
}

async function execute(msPda: PublicKey, transactionIndex: bigint, executor: Keypair): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex, member: executor.publicKey });
      const sig = await send([EXECUTE_CU, instruction], [executor]);
      console.log(`Upgrade executado: ${sig}`);
      return sig;
    } catch (e) {
      console.log(`Execução, tentativa ${attempt}: ${errorText(e, attempt === 1 ? 15 : 0)}`);
      await sleep(60_000);
    }
  }
  throw new Error("Upgrade não executado");
}

// Proposta aprovada em outra rodada: confere na rede que está aprovada e que o prazo passou, e executa.
async function executePending(dep: any, msPda: PublicKey, index: bigint, members: Keypair[], timeLock: number) {
  const [proposalPda] = multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index });
  const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda, "confirmed");
  if (proposal.status.__kind !== "Approved") throw new Error(`Proposta #${index} não está aprovada`);
  const approvedAt = Number(proposal.status.timestamp) * 1000;
  const approvers = proposal.approved.map((k) => k.toBase58());
  console.log(`Proposta #${index}: ${approvers.length} aprovações, aprovada em ${new Date(approvedAt).toISOString()}.`);
  await sleep(Math.max(0, approvedAt + (timeLock + 30) * 1000 - Date.now()));
  const executor = members.find((m) => approvers.includes(m.publicKey.toBase58()))!;
  const executeSig = await execute(msPda, index, executor);
  const reason = process.env.REASON ?? "Atualização do programa";
  record(dep, {
    index: Number(index),
    action: `Upgrade do programa: ${reason}`,
    at: new Date().toISOString(),
    proposer: executor.publicKey.toBase58(),
    approvals: approvers.map((member) => ({ member })),
    executeSignature: executeSig,
    timeLockSecs: timeLock,
    waitedMinutes: Math.round((Date.now() - approvedAt) / 60_000),
    earlyExecutionRefused: true, // conferido na rodada que aprovou (log do workflow)
  });
}

function record(dep: any, entry: Record<string, any>, approveSig?: string) {
  dep.consortium.upgrade.history = [entry, ...(dep.consortium.upgrade.history ?? [])];
  dep.updatedAt = new Date().toISOString();
  writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
  writeFileSync("app/src/devnet.json", JSON.stringify(dep, null, 2) + "\n");
  const approvals = approveSig ? `[assinaturas](${explorer(approveSig)})` : "na rodada anterior";
  const md = `## Upgrade governado do programa v2\n\n- Proposta #${entry.index}: ${entry.action}\n- ${entry.approvals.length} de 10 Baleias aprovaram (${approvals})\n- Execução antes do prazo: recusada\n- Executado depois de ${entry.waitedMinutes} min de espera ([execução](${explorer(entry.executeSignature)}))\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
