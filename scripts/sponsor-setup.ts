// Prepara a carteira patrocinadora da devnet usada pelo app (app/src/chain/sponsor.json):
// - passa para ela a autoridade de emissão das moedas de teste (cBRL e cUSD), para o app dar R$ 1.000 a cada conta nova;
// - mantém SOL de devnet nela, para pagar a criação das contas e as taxas;
// - cria as contas de token dela, que fazem o papel do parceiro de Pix/ACH na devnet.
// Idempotente: pode rodar a cada 15 minutos junto com o oráculo.
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import {
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { appendFileSync, readFileSync } from "fs";
import idl from "../idl/cambi_pool.json";
import { BALEIA, politeConnection, positionPda, u } from "./common";

const MIN_SOL = 0.5;
const TARGET_SOL = 1.5;
/** Liquidez mínima livre em cada cofre; abaixo disso o patrocinador entra como Baleia para a demo não travar. */
const MIN_FREE = { brl: 20_000, usd: 4_000 };
const REFILL = { brl: 50_000, usd: 10_000 };

async function main() {
  const deployment = JSON.parse(readFileSync("deployments/devnet.json", "utf8"));
  const sponsorKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("app/src/chain/sponsor.json", "utf8")).secretKey));
  const sponsor = sponsorKp.publicKey;
  const env = anchor.AnchorProvider.env();
  const connection = politeConnection(env.connection.rpcEndpoint);
  const provider = new anchor.AnchorProvider(connection, env.wallet, { commitment: "confirmed" });
  const admin = provider.wallet.publicKey;
  const lines: string[] = [];
  const tx = new Transaction();

  for (const [label, mintStr] of [["cBRL", deployment.brlMint], ["cUSD", deployment.usdMint]] as const) {
    const mint = new PublicKey(mintStr);
    const info = await getMint(connection, mint, "confirmed");
    if (info.mintAuthority?.equals(admin)) {
      tx.add(createSetAuthorityInstruction(mint, admin, AuthorityType.MintTokens, sponsor));
      lines.push(`${label}: autoridade de emissão passa para o patrocinador`);
    } else {
      lines.push(`${label}: autoridade de emissão = ${info.mintAuthority?.toBase58() ?? "nenhuma"}`);
    }
    tx.add(createAssociatedTokenAccountIdempotentInstruction(admin, getAssociatedTokenAddressSync(mint, sponsor), sponsor, mint));
  }

  const sponsorSol = (await connection.getBalance(sponsor, "confirmed")) / LAMPORTS_PER_SOL;
  const adminSol = (await connection.getBalance(admin, "confirmed")) / LAMPORTS_PER_SOL;
  if (sponsorSol < MIN_SOL) {
    const top = Math.min(TARGET_SOL - sponsorSol, Math.max(0, adminSol - 0.3));
    if (top > 0.01) {
      tx.add(SystemProgram.transfer({ fromPubkey: admin, toPubkey: sponsor, lamports: Math.floor(top * LAMPORTS_PER_SOL) }));
      lines.push(`Patrocinador recebe ${top.toFixed(3)} SOL (tinha ${sponsorSol.toFixed(3)})`);
    } else {
      lines.push(`ATENÇÃO: patrocinador com ${sponsorSol.toFixed(3)} SOL e admin sem SOL para repor (${adminSol.toFixed(3)})`);
    }
  } else {
    lines.push(`Patrocinador com ${sponsorSol.toFixed(3)} SOL`);
  }

  const sig = await provider.sendAndConfirm(tx);
  lines.push(`Admin: ${adminSol.toFixed(3)} SOL · transação ${sig}`);

  // Liquidez do pool: se um cofre ficou com pouca liquidez livre, o patrocinador deposita como Baleia.
  const program = new Program(idl as Idl, provider);
  const poolKey = new PublicKey(deployment.pool);
  const pool = await (program.account as any).pool.fetch(poolKey);
  const free = async (side: 0 | 1) => {
    const vault = new PublicKey(side === 0 ? deployment.brlVault : deployment.usdVault);
    const bal = BigInt((await connection.getTokenAccountBalance(vault, "confirmed")).value.amount);
    const reserved = BigInt(pool.platformFees[side].toString()) + BigInt(pool.partnerFees[side].toString()) + BigInt(pool.lpFeesUnclaimed[side].toString());
    return Number(bal - reserved) / 1e6;
  };
  for (const [side, key, mintStr] of [[0, "brl", deployment.brlMint], [1, "usd", deployment.usdMint]] as const) {
    const now = await free(side);
    if (now >= MIN_FREE[key]) {
      lines.push(`Liquidez livre ${key.toUpperCase()}: ${now.toLocaleString("pt-BR")} (ok)`);
      continue;
    }
    const mint = new PublicKey(mintStr);
    const amount = u(REFILL[key]);
    const refill = new Transaction().add(
      createMintToInstruction(mint, getAssociatedTokenAddressSync(mint, sponsor), sponsor, BigInt(amount.toString())),
    );
    await provider.sendAndConfirm(refill, [sponsorKp]);
    const dep = await program.methods
      .deposit(BALEIA, side, amount)
      .accountsPartial({
        user: sponsor,
        pool: poolKey,
        position: positionPda(program.programId, poolKey, sponsor, BALEIA, side),
        brlVault: new PublicKey(deployment.brlVault),
        usdVault: new PublicKey(deployment.usdVault),
        userBrl: getAssociatedTokenAddressSync(new PublicKey(deployment.brlMint), sponsor),
        userUsd: getAssociatedTokenAddressSync(new PublicKey(deployment.usdMint), sponsor),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsorKp])
      .rpc();
    lines.push(`Liquidez livre ${key.toUpperCase()} estava em ${now.toLocaleString("pt-BR")}: patrocinador depositou ${REFILL[key].toLocaleString("pt-BR")} como Baleia (${dep})`);
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Patrocinador da devnet\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
