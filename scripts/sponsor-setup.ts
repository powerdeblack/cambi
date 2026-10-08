// Prepara a carteira patrocinadora da devnet usada pelo app (app/src/chain/sponsor.json):
// - passa para ela a autoridade de emissão das moedas de teste (cBRL e cUSD), para o app dar R$ 1.000 a cada conta nova;
// - mantém SOL de devnet nela, para pagar a criação das contas e as taxas;
// - cria as contas de token dela, que fazem o papel do parceiro de Pix/ACH na devnet.
// Idempotente: pode rodar a cada 15 minutos junto com o oráculo.
import * as anchor from "@coral-xyz/anchor";
import {
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { appendFileSync, readFileSync } from "fs";
import { politeConnection } from "./common";

const MIN_SOL = 0.5;
const TARGET_SOL = 1.5;

async function main() {
  const deployment = JSON.parse(readFileSync("deployments/devnet.json", "utf8"));
  const sponsor = new PublicKey(JSON.parse(readFileSync("app/src/chain/sponsor.json", "utf8")).publicKey);
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
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Patrocinador da devnet\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
