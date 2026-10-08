// Monta um pool de demonstração na devnet e registra as transações como prova pública.
// Uso (no GitHub Actions): ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=... npm run devnet:setup
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { CambiPool } from "../target/types/cambi_pool";
import idl from "../target/idl/cambi_pool.json";
import {
  BALEIA,
  BRL,
  RENDE,
  USD,
  User,
  createMints,
  partnerPda,
  poolPda,
  positionPda,
  setupUser,
  u,
  vaultPda,
} from "./common";

const PRICE_RAW = new anchor.BN(5_400_000); // R$ 5,40 por dólar (cotação de demonstração)
const MAX_PRICE_AGE = new anchor.BN(60 * 60 * 24 * 30); // 30 dias, para a demo continuar utilizável

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program<CambiPool>(idl as CambiPool, provider);
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;
  const txs: { label: string; signature: string }[] = [];
  const log = (label: string, signature: string) => {
    txs.push({ label, signature });
    console.log(`${label}: ${signature}`);
  };

  async function fund(kp: Keypair, sol: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: sol * LAMPORTS_PER_SOL }),
    );
    await provider.sendAndConfirm(tx);
  }

  const mints = await createMints(connection, admin);
  const pool = poolPda(pid, mints.brl, mints.usd);
  const brlVault = vaultPda(pid, pool, mints.brl);
  const usdVault = vaultPda(pid, pool, mints.usd);

  log(
    "Pool criado (R$ 5,40 por dólar)",
    await program.methods
      .initialize(PRICE_RAW, MAX_PRICE_AGE)
      .accountsPartial({
        admin: admin.publicKey,
        brlMint: mints.brl,
        usdMint: mints.usd,
        pool,
        brlVault,
        usdVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );

  const rende = await setupUser(connection, admin, mints, { brl: 60_000, usd: 12_000 });
  const retail = await setupUser(connection, admin, mints, { brl: 5_000, usd: 0 });
  const app = await setupUser(connection, admin, mints, { brl: 0, usd: 1_000 });
  const baleia = await setupUser(connection, admin, mints, { brl: 10_000, usd: 2_000 }, { kp: Keypair.generate() });
  for (const usr of [rende, retail, app, baleia]) await fund(usr.kp, 0.05);

  const deposit = (usr: User, tranche: number, side: number, amount: number) =>
    program.methods
      .deposit(tranche, side, u(amount))
      .accountsPartial({
        user: usr.kp.publicKey,
        pool,
        position: positionPda(pid, pool, usr.kp.publicKey, tranche, side),
        brlVault,
        usdVault,
        userBrl: usr.brl,
        userUsd: usr.usd,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([usr.kp])
      .rpc();

  const swap = (usr: User, side: number, amount: number, extra: { position?: PublicKey; partner?: PublicKey } = {}) =>
    program.methods
      .swap(side, u(amount), u(0))
      .accountsPartial({
        user: usr.kp.publicKey,
        pool,
        brlVault,
        usdVault,
        userBrl: usr.brl,
        userUsd: usr.usd,
        depositorPosition: extra.position ?? null,
        partner: extra.partner ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([usr.kp])
      .rpc();

  log("Depósito Rende: R$ 50.000", await deposit(rende, RENDE, BRL, 50_000));
  log("Depósito Rende: US$ 10.000", await deposit(rende, RENDE, USD, 10_000));
  log("Depósito Baleia: R$ 10.000", await deposit(baleia, BALEIA, BRL, 10_000));
  log("Depósito Baleia: US$ 2.000", await deposit(baleia, BALEIA, USD, 2_000));

  log("Troca varejo: R$ 1.000 → dólar (taxa 1%)", await swap(retail, BRL, 1_000));
  log(
    "Troca depositante: R$ 1.000 → dólar (taxa 0,5%)",
    await swap(rende, BRL, 1_000, { position: positionPda(pid, pool, rende.kp.publicKey, RENDE, BRL) }),
  );

  const partner = partnerPda(pid, pool, app.kp.publicKey);
  log(
    "App parceiro registrado",
    await program.methods
      .addPartner()
      .accountsPartial({ admin: admin.publicKey, pool, partnerAuthority: app.kp.publicKey, partner, systemProgram: SystemProgram.programId })
      .rpc(),
  );
  log("Troca B2B: US$ 200 → real (taxa 0,4%)", await swap(app, USD, 200, { partner }));

  log(
    "Depositante colhe as taxas (nas duas moedas)",
    await program.methods
      .withdraw(u(0))
      .accountsPartial({
        user: rende.kp.publicKey,
        pool,
        position: positionPda(pid, pool, rende.kp.publicKey, RENDE, USD),
        brlVault,
        usdVault,
        userBrl: rende.brl,
        userUsd: rende.usd,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([rende.kp])
      .rpc(),
  );

  const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
  const deployment = {
    cluster: "devnet",
    rpc: "https://api.devnet.solana.com",
    createdAt: new Date().toISOString(),
    programId: pid.toBase58(),
    pool: pool.toBase58(),
    brlMint: mints.brl.toBase58(),
    usdMint: mints.usd.toBase58(),
    brlVault: brlVault.toBase58(),
    usdVault: usdVault.toBase58(),
    admin: admin.publicKey.toBase58(),
    transactions: txs.map((t) => ({ ...t, url: explorer("tx", t.signature) })),
    links: { program: explorer("address", pid.toBase58()), pool: explorer("address", pool.toBase58()) },
  };

  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/devnet.json", JSON.stringify(deployment, null, 2) + "\n");
  writeFileSync("app/src/devnet.json", JSON.stringify(deployment, null, 2) + "\n");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = deployment.transactions.map((t) => `| ${t.label} | [ver transação](${t.url}) |`).join("\n");
    appendFileSync(
      summary,
      `## cambI na devnet\n\n- Programa: [${deployment.programId}](${deployment.links.program})\n- Pool: [${deployment.pool}](${deployment.links.pool})\n\n| Operação | Prova |\n|---|---|\n${rows}\n`,
    );
  }
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
