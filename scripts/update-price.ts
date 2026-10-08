// Oráculo da devnet: lê o dólar ao vivo (Pyth, com fontes de reserva) e grava a cotação no pool.
// Roda no GitHub Actions a cada 15 minutos (workflow "Oráculo da devnet").
// Uso: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=... npm run devnet:price
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { appendFileSync, readFileSync } from "fs";
import { fetchLiveQuote } from "../app/src/quote";
import { politeConnection } from "./common";
import idl from "../idl/cambi_pool.json";

const PRICE_SCALE = 1_000_000;
/** Disjuntor: uma variação maior que esta entre duas leituras é tratada como erro da fonte, não como câmbio. */
const MAX_JUMP = 0.1;

async function main() {
  const deployment = JSON.parse(readFileSync("deployments/devnet.json", "utf8"));
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(politeConnection(env.connection.rpcEndpoint), env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl as Idl, provider);
  const pool = new PublicKey(deployment.pool);

  const before = await (program.account as any).pool.fetch(pool);
  const oldPrice = Number(before.price.toString()) / PRICE_SCALE;
  const quote = await fetchLiveQuote(undefined, (reason) => console.log(`Fonte pulada: ${reason}`));

  const jump = Math.abs(quote.price / oldPrice - 1);
  if (jump > MAX_JUMP) {
    throw new Error(
      `Variação de ${(jump * 100).toFixed(1)}% (${oldPrice} → ${quote.price}, ${quote.source}) acima do limite de ` +
        `${MAX_JUMP * 100}%. Cotação não gravada; confira as fontes.`,
    );
  }

  const raw = new anchor.BN(Math.round(quote.price * PRICE_SCALE));
  const signature = await program.methods
    .setPrice(raw)
    .accountsPartial({ oracle: provider.wallet.publicKey, pool })
    .rpc();

  const published = new Date(quote.publishedAt * 1000).toISOString();
  const line = `R$ ${oldPrice.toFixed(4)} → R$ ${quote.price.toFixed(4)} (${quote.source}, publicada ${published})`;
  console.log(line);
  console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Oráculo da devnet\n\n${line}\n\n[Ver transação](https://explorer.solana.com/tx/${signature}?cluster=devnet)\n`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
