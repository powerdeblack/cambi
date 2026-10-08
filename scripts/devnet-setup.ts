// Monta o pool da devnet (v2) e registra as transações como prova pública.
// - moedas de teste com autoridade de emissão num PDA do programa (faucet on-chain; nenhuma chave no app);
// - oráculo com chave própria (separada do admin), limites de segurança e liquidez inicial;
// - trocas de demonstração (varejo, depositante, B2B) e colheita de taxas.
// Uso (no GitHub Actions): ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=<admin> ORACLE_KEYPAIR=<arquivo> npm run devnet:setup
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AuthorityType, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, setAuthority } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fetchConsensusQuote } from "../app/src/quote";
import { CambiPool } from "../target/types/cambi_pool";
import idl from "../target/idl/cambi_pool.json";
import {
  BALEIA,
  BRL,
  RENDE,
  USD,
  createMints,
  mintAuthorityPda,
  partnerPda,
  politeConnection,
  poolPda,
  positionPda,
  programDataPda,
  u,
  vaultPda,
} from "./common";

const MAX_PRICE_AGE = 3_600; // cotação vale 1 hora (oráculo grava a cada 15 minutos)
const MAX_PRICE_MOVE_BPS = 1_000; // até 10% por atualização
const LOCKUP_SECS = 600; // principal travado 10 minutos após cada depósito
const CONFIRMED = { commitment: "confirmed" as const };

async function main() {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(politeConnection(env.connection.rpcEndpoint), env.wallet, CONFIRMED);
  anchor.setProvider(provider);
  const program = new Program<CambiPool>(idl as CambiPool, provider);
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;
  const oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ORACLE_KEYPAIR!, "utf8"))));
  const txs: { label: string; signature: string }[] = [];
  const log = (label: string, signature: string) => {
    txs.push({ label, signature });
    console.log(`${label}: ${signature}`);
  };

  // Cotação inicial por consenso de fontes (com reserva fixa se a internet do runner falhar).
  let price = 5.0;
  try {
    price = (await fetchConsensusQuote()).price;
  } catch (e) {
    console.log(`Consenso indisponível, usando ${price}: ${(e as Error).message}`);
  }
  const priceRaw = new anchor.BN(Math.round(price * 1e6));

  const mints = await createMints(connection, admin);
  const pool = poolPda(pid, mints.brl, mints.usd);
  const brlVault = vaultPda(pid, pool, mints.brl);
  const usdVault = vaultPda(pid, pool, mints.usd);
  const mintAuthority = mintAuthorityPda(pid, pool);

  log(
    `Pool v2 criado (R$ ${price.toFixed(4)} por dólar), só pela autoridade de upgrade`,
    await program.methods
      .initialize(priceRaw, new anchor.BN(MAX_PRICE_AGE))
      .accountsPartial({
        admin: admin.publicKey,
        brlMint: mints.brl,
        usdMint: mints.usd,
        pool,
        brlVault,
        usdVault,
        program: pid,
        programData: programDataPda(pid),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );
  log(
    "Limites: cotação vale 1 h, oráculo move até 10% por vez, depósito travado 10 min",
    await program.methods
      .setLimits(new anchor.BN(MAX_PRICE_AGE), MAX_PRICE_MOVE_BPS, new anchor.BN(LOCKUP_SECS))
      .accountsPartial({ admin: admin.publicKey, pool })
      .rpc(),
  );
  log("Oráculo com chave própria (separada do admin)", await program.methods.setOracle(oracle.publicKey).accountsPartial({ admin: admin.publicKey, pool }).rpc());
  await provider.sendAndConfirm(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: oracle.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL })),
  );

  // Emissão das moedas de teste passa para o PDA do programa: só o faucet (com regras) e o admin_mint emitem.
  await setAuthority(connection, admin, mints.brl, admin, AuthorityType.MintTokens, mintAuthority, [], CONFIRMED);
  await setAuthority(connection, admin, mints.usd, admin, AuthorityType.MintTokens, mintAuthority, [], CONFIRMED);
  console.log(`Autoridade de emissão das moedas de teste: PDA ${mintAuthority.toBase58()}`);

  // Participantes da demonstração (chaves descartáveis), com SOL do admin para as taxas.
  const people = { rende: Keypair.generate(), baleia: Keypair.generate(), retail: Keypair.generate(), app: Keypair.generate() };
  const fund = new Transaction();
  for (const kp of Object.values(people)) fund.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }));
  await provider.sendAndConfirm(fund);
  const atas = async (kp: Keypair) => ({
    brl: await createAssociatedTokenAccountIdempotent(connection, admin, mints.brl, kp.publicKey, CONFIRMED),
    usd: await createAssociatedTokenAccountIdempotent(connection, admin, mints.usd, kp.publicKey, CONFIRMED),
  });
  const acc = { rende: await atas(people.rende), baleia: await atas(people.baleia), retail: await atas(people.retail), app: await atas(people.app) };
  const adminMint = (side: number, amount: number, destination: PublicKey) =>
    program.methods
      .adminMint(side, u(amount))
      .accountsPartial({ admin: admin.publicKey, pool, mint: side === BRL ? mints.brl : mints.usd, destination, mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
  await adminMint(BRL, 60_000, acc.rende.brl);
  await adminMint(USD, 12_000, acc.rende.usd);
  await adminMint(BRL, 10_000, acc.baleia.brl);
  await adminMint(USD, 2_000, acc.baleia.usd);
  await adminMint(BRL, 5_000, acc.retail.brl);
  await adminMint(USD, 1_000, acc.app.usd);

  type Who = keyof typeof people;
  const deposit = (who: Who, tranche: number, side: number, amount: number) =>
    program.methods
      .deposit(tranche, side, u(amount))
      .accountsPartial({
        user: people[who].publicKey,
        pool,
        position: positionPda(pid, pool, people[who].publicKey, tranche, side),
        brlVault,
        usdVault,
        userBrl: acc[who].brl,
        userUsd: acc[who].usd,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([people[who]])
      .rpc();
  const swap = (who: Who, side: number, amount: number, extra: { position?: PublicKey; partner?: PublicKey } = {}) =>
    program.methods
      .swap(side, u(amount), u(0))
      .accountsPartial({
        user: people[who].publicKey,
        pool,
        brlVault,
        usdVault,
        userBrl: acc[who].brl,
        userUsd: acc[who].usd,
        depositorPosition: extra.position ?? null,
        partner: extra.partner ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([people[who]])
      .rpc();

  log("Depósito Rende: R$ 50.000", await deposit("rende", RENDE, BRL, 50_000));
  log("Depósito Rende: US$ 10.000", await deposit("rende", RENDE, USD, 10_000));
  log("Depósito Baleia: R$ 10.000", await deposit("baleia", BALEIA, BRL, 10_000));
  log("Depósito Baleia: US$ 2.000", await deposit("baleia", BALEIA, USD, 2_000));
  log("Troca varejo: R$ 1.000 → dólar (taxa 1%)", await swap("retail", BRL, 1_000));
  log(
    "Troca depositante: R$ 1.000 → dólar (taxa 0,5%)",
    await swap("rende", BRL, 1_000, { position: positionPda(pid, pool, people.rende.publicKey, RENDE, BRL) }),
  );
  const partner = partnerPda(pid, pool, people.app.publicKey);
  log(
    "App parceiro registrado",
    await program.methods
      .addPartner()
      .accountsPartial({ admin: admin.publicKey, pool, partnerAuthority: people.app.publicKey, partner, systemProgram: SystemProgram.programId })
      .rpc(),
  );
  log("Troca B2B: US$ 200 → real (taxa 0,4%)", await swap("app", USD, 200, { partner }));
  log(
    "Depositante colhe as taxas (nas duas moedas)",
    await program.methods
      .withdraw(u(0))
      .accountsPartial({
        user: people.rende.publicKey,
        pool,
        position: positionPda(pid, pool, people.rende.publicKey, RENDE, USD),
        brlVault,
        usdVault,
        userBrl: acc.rende.brl,
        userUsd: acc.rende.usd,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([people.rende])
      .rpc(),
  );

  const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
  const deployment = {
    cluster: "devnet",
    version: 2,
    rpc: "https://api.devnet.solana.com",
    createdAt: new Date().toISOString(),
    programId: pid.toBase58(),
    pool: pool.toBase58(),
    brlMint: mints.brl.toBase58(),
    usdMint: mints.usd.toBase58(),
    brlVault: brlVault.toBase58(),
    usdVault: usdVault.toBase58(),
    mintAuthority: mintAuthority.toBase58(),
    admin: admin.publicKey.toBase58(),
    oracle: oracle.publicKey.toBase58(),
    // Carteira que faz o papel do parceiro de Pix/ACH na devnet (só o endereço público vai para o app).
    payout: admin.publicKey.toBase58(),
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
      `## cambI na devnet (v2)\n\n- Programa: [${deployment.programId}](${deployment.links.program})\n- Pool: [${deployment.pool}](${deployment.links.pool})\n- Oráculo: \`${deployment.oracle}\`\n\n| Operação | Prova |\n|---|---|\n${rows}\n`,
    );
  }
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
