// Desativa a antiga carteira patrocinadora da devnet, cuja chave ficou pública no app (versão 1):
// - tira dela a autoridade de emissão das moedas de teste antigas (passa a não existir autoridade);
// - devolve o SOL dela para o admin.
// Depois disso a chave antiga não tem poder sobre nada. Uso: OLD_SPONSOR=<arquivo> OLD_DEPLOYMENT=<arquivo> npm run devnet:retire-sponsor
import * as anchor from "@coral-xyz/anchor";
import { AuthorityType, createSetAuthorityInstruction, getMint } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { politeConnection } from "./common";

async function main() {
  const file = process.env.OLD_SPONSOR!;
  if (!file || !existsSync(file)) {
    console.log("Sem carteira patrocinadora antiga para desativar.");
    return;
  }
  const old = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")).secretKey));
  const oldDeployment = JSON.parse(readFileSync(process.env.OLD_DEPLOYMENT!, "utf8"));
  const env = anchor.AnchorProvider.env();
  const connection = politeConnection(env.connection.rpcEndpoint);
  const admin = env.wallet.publicKey;
  const lines: string[] = [`Carteira antiga: ${old.publicKey.toBase58()}`];

  const tx = new Transaction();
  for (const m of [oldDeployment.brlMint, oldDeployment.usdMint].filter(Boolean)) {
    const info = await getMint(connection, new PublicKey(m), "confirmed").catch(() => null);
    if (info?.mintAuthority?.equals(old.publicKey)) {
      tx.add(createSetAuthorityInstruction(new PublicKey(m), old.publicKey, AuthorityType.MintTokens, null));
      lines.push(`Moeda de teste antiga ${m}: emissão revogada (sem autoridade)`);
    }
  }
  const lamports = await connection.getBalance(old.publicKey, "confirmed");
  const fee = 10_000;
  if (tx.instructions.length > 0 || lamports > fee) {
    tx.feePayer = old.publicKey;
    if (lamports > fee * 2) tx.add(SystemProgram.transfer({ fromPubkey: old.publicKey, toPubkey: admin, lamports: lamports - fee * 2 }));
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(old);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    lines.push(`SOL devolvido ao admin: ${(lamports / 1e9).toFixed(4)} · transação ${sig}`);
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Carteira patrocinadora antiga desativada\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
