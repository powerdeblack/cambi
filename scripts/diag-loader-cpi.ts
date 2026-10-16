// Diagnóstico: a devnet aceita chamadas ao BPF Loader Upgradeable feitas por DENTRO de outro programa (CPI)?
//
// O upgrade governado do v2.5 foi recusado na execução com "Program BPFLoaderUpgradeab1e… not supported by inner
// instructions". Se a rede recusa QUALQUER instrução do loader via CPI, o cofre da multisig (uma PDA, que só assina
// por CPI) não consegue atualizar o programa nem devolver a autoridade. Este teste não toca o programa nem o pool:
// cria uma multisig 1 de 1 descartável, um buffer pequeno e pede ao cofre, por CPI, que mude a autoridade do buffer.
// Controle: o mesmo cofre faz uma transferência do System Program por CPI.
//
// Uso (GitHub Actions): ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/diag-loader-cpi.ts
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

async function main() {
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));

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
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 0.01 * LAMPORTS_PER_SOL }),
    ],
    [payer, createKey],
  );
  console.log(`Multisig de teste ${msPda.toBase58()} · cofre ${vault.toBase58()}`);

  // Buffer pequeno do loader, com autoridade = cofre.
  const buffer = Keypair.generate();
  const space = 37 + 8;
  await send(
    [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: buffer.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(space), space, programId: LOADER }),
      new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: false }], data: u32(0) }),
    ],
    [payer, buffer],
  );
  console.log(`Buffer de teste ${buffer.publicKey.toBase58()} (autoridade: cofre)`);

  // Cada teste: proposta, aprovação, simulação da execução (1,4 mi de unidades) e, se passar, execução.
  let index = 0n;
  async function viaVault(name: string, ixs: TransactionInstruction[]) {
    index += 1n;
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
    try {
      const sig = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction], [payer]);
      console.log(`OK  ${name}: ${sig}`);
      return { name, ok: true, signature: sig };
    } catch (e) {
      const logs = logsOf(e);
      console.log(`NÃO ${name}:\n  ${logs.slice(-6).join("\n  ")}`);
      return { name, ok: false, logs: logs.slice(-6) };
    }
  }

  const results = [
    await viaVault("controle: System Program por CPI (transferência do cofre)", [SystemProgram.transfer({ fromPubkey: vault, toPubkey: payer.publicKey, lamports: 1000 })]),
    await viaVault("loader por CPI: SetAuthority do buffer (cofre → deployer)", [
      new TransactionInstruction({
        programId: LOADER,
        keys: [
          { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: true, isWritable: false },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        ],
        data: u32(4),
      }),
    ]),
  ];

  const out = { at: new Date().toISOString(), multisig: msPda.toBase58(), vault: vault.toBase58(), buffer: buffer.publicKey.toBase58(), results };
  writeFileSync("deployments/diag-loader-cpi.json", JSON.stringify(out, null, 2) + "\n");
  const md = `## Diagnóstico: loader por CPI na devnet\n\n${results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n  - ${(r as { logs: string[] }).logs.at(-1)}`}`).join("\n")}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
