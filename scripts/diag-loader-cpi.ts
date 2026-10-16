// Diagnóstico: a devnet aceita chamadas ao BPF Loader Upgradeable feitas por DENTRO de outro programa (CPI)?
//
// O upgrade governado do v2.5 foi recusado na execução com "Program BPFLoaderUpgradeab1e… not supported by inner
// instructions". Se a rede recusa QUALQUER instrução do loader via CPI, o cofre da multisig (uma PDA, que só assina
// por CPI) não consegue atualizar o programa nem devolver a autoridade. Este teste não toca o programa nem o pool:
// cria uma multisig 1 de 1 descartável, um buffer pequeno e pede ao cofre, por CPI, que mude a autoridade do buffer.
// Controle: o mesmo cofre faz uma transferência do System Program por CPI.
//
// Rodada 2 (com um programa vazio de teste, diag/noop, cuja autoridade de upgrade é o cofre): Upgrade por CPI,
// ExtendProgramChecked por CPI e ExtendProgram (sem autoridade) direto, fora da multisig.
//
// Uso (GitHub Actions): ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/diag-loader-cpi.ts setup
//   (o workflow faz deploy do programa vazio e passa a autoridade ao cofre) e depois
//   NOOP_PROGRAM=… NOOP_BUFFER=… npx tsx scripts/diag-loader-cpi.ts run
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { appendFileSync, readFileSync, writeFileSync } from "fs";

const { Permissions } = multisig.types;
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Transação falhou ${sig}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`Sem confirmação: ${sig}`);
}

function logsOf(e: unknown): string[] {
  const err = e as Error & { logs?: string[]; transactionLogs?: string[] };
  return err.logs ?? err.transactionLogs ?? [err.message.split("\n")[0]];
}

const STATE = "/tmp/diag-loader-cpi.json";

async function main() {
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  if (process.argv[2] === "run") return run(payer);

  // Multisig 1 de 1, sem prazo de espera.
  const createKey = Keypair.generate();
  const [msPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  await send(
    [
      multisig.instructions.multisigCreateV2({
        treasury: programConfig.treasury,
        creator: payer.publicKey,
        multisigPda: msPda,
        configAuthority: null,
        threshold: 1,
        members: [{ key: payer.publicKey, permissions: Permissions.all() }],
        timeLock: 0,
        createKey: createKey.publicKey,
        rentCollector: null,
      }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 0.05 * LAMPORTS_PER_SOL }),
    ],
    [payer, createKey],
  );
  console.log(`Multisig de teste ${msPda.toBase58()} · cofre ${vault.toBase58()}`);
  writeFileSync(STATE, JSON.stringify({ multisig: msPda.toBase58(), vault: vault.toBase58() }));
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `DIAG_VAULT=${vault.toBase58()}\n`);
}

// Cada teste: proposta, aprovação e execução (1,4 mi de unidades) pelo cofre da multisig de teste.
async function viaVault(payer: Keypair, msPda: PublicKey, name: string, ixs: TransactionInstruction[]) {
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
  const index = BigInt(info.transactionIndex.toString()) + 1n;
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  await send(
    [
      multisig.instructions.vaultTransactionCreate({ multisigPda: msPda, transactionIndex: index, creator: payer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: ixs }) }),
      multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex: index, creator: payer.publicKey }),
      multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: payer.publicKey }),
    ],
    [payer],
  );
  const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex: index, member: payer.publicKey });
  return attempt(name, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction], [payer]);
}

async function attempt(name: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  try {
    const sig = await send(ixs, signers);
    console.log(`OK  ${name}: ${sig}`);
    return { name, ok: true, signature: sig };
  } catch (e) {
    const logs = logsOf(e);
    console.log(`NÃO ${name}:\n  ${logs.slice(-6).join("\n  ")}`);
    return { name, ok: false, logs: logs.slice(-6) };
  }
}

async function report(results: { name: string; ok: boolean; logs?: string[] }[], extra: Record<string, string>) {
  const file = "deployments/diag-loader-cpi.json";
  const prev = (() => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } })();
  const out = { ...prev, at: new Date().toISOString(), ...extra, results: [...(prev.results ?? []), ...results] };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  const md = `## Diagnóstico: loader por CPI na devnet\n\n${results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n  - ${r.logs?.at(-1)}`}`).join("\n")}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

// Rodada 2: o programa vazio já tem o cofre como autoridade de upgrade, e o buffer também.
async function run(payer: Keypair) {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const msPda = new PublicKey(st.multisig);
  const vault = new PublicKey(st.vault);
  const program = new PublicKey(process.env.NOOP_PROGRAM!);
  const buffer = new PublicKey(process.env.NOOP_BUFFER!);
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  const results = [
    await viaVault(payer, msPda, "Upgrade por CPI (cofre é a autoridade)", [
      new TransactionInstruction({
        programId: LOADER,
        keys: [
          { pubkey: programData, isSigner: false, isWritable: true },
          { pubkey: program, isSigner: false, isWritable: true },
          { pubkey: buffer, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: true },
          { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
          { pubkey: new PublicKey("SysvarC1ock11111111111111111111111111111111"), isSigner: false, isWritable: false },
          { pubkey: vault, isSigner: true, isWritable: false },
        ],
        data: u32(3),
      }),
    ]),
    await viaVault(payer, msPda, "ExtendProgramChecked por CPI (+1 KB)", [
      new TransactionInstruction({
        programId: LOADER,
        keys: [
          { pubkey: programData, isSigner: false, isWritable: true },
          { pubkey: program, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: true, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: vault, isSigner: true, isWritable: true },
        ],
        data: Buffer.concat([u32(9), u32(1024)]),
      }),
    ]),
    await attempt(
      "ExtendProgram sem autoridade, direto (fora da multisig, +1 KB)",
      [
        new TransactionInstruction({
          programId: LOADER,
          keys: [
            { pubkey: programData, isSigner: false, isWritable: true },
            { pubkey: program, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          ],
          data: Buffer.concat([u32(6), u32(1024)]),
        }),
      ],
      [payer],
    ),
  ];
  await report(results, { noopProgram: program.toBase58() });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
