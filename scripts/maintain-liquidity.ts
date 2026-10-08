// Manutenção da demonstração na devnet, com a chave de admin (só no GitHub Actions):
// - mantém SOL na chave do oráculo;
// - mantém a validade da cotação em 24 h (o agendador do GitHub atrasa o oráculo por horas);
// - repõe liquidez do pool como Baleia (via admin_mint, instrução que só existe na versão devnet do programa)
//   quando um cofre fica com pouca liquidez livre.
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { appendFileSync, readFileSync } from "fs";
import idl from "../idl/cambi_pool.json";
import { BALEIA, politeConnection, positionPda, u } from "./common";

const MIN_FREE = { brl: 20_000, usd: 4_000 };
const REFILL = { brl: 50_000, usd: 10_000 };
const ORACLE_MIN_SOL = 0.1;
// Máximo aceito pelo programa (MAX_PRICE_AGE_LIMIT). O limite de variação por atualização (10%) continua valendo.
const DEVNET_MAX_PRICE_AGE = 86_400;

async function main() {
  const d = JSON.parse(readFileSync("deployments/devnet.json", "utf8"));
  const env = anchor.AnchorProvider.env();
  const connection = politeConnection(env.connection.rpcEndpoint);
  const provider = new anchor.AnchorProvider(connection, env.wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const admin = (provider.wallet as anchor.Wallet).payer;
  const lines: string[] = [];

  const oracle = new PublicKey(d.oracle);
  const oracleSol = (await connection.getBalance(oracle, "confirmed")) / LAMPORTS_PER_SOL;
  if (oracleSol < ORACLE_MIN_SOL) {
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: oracle, lamports: 0.2 * LAMPORTS_PER_SOL })));
    lines.push(`Oráculo recebeu 0,2 SOL (tinha ${oracleSol.toFixed(3)})`);
  } else lines.push(`Oráculo com ${oracleSol.toFixed(3)} SOL`);

  const poolKey = new PublicKey(d.pool);
  const pool = await (program.account as any).pool.fetch(poolKey);

  const maxAge = Number(pool.maxPriceAge.toString());
  if (maxAge !== DEVNET_MAX_PRICE_AGE) {
    const sig = await program.methods
      .setLimits(new anchor.BN(DEVNET_MAX_PRICE_AGE), pool.maxPriceMoveBps, pool.lockupSecs)
      .accountsPartial({ admin: admin.publicKey, pool: poolKey })
      .rpc();
    lines.push(`Validade da cotação: ${maxAge / 3600} h → ${DEVNET_MAX_PRICE_AGE / 3600} h (${sig})`);
  } else lines.push(`Validade da cotação: ${maxAge / 3600} h (ok)`);

  const mints = [new PublicKey(d.brlMint), new PublicKey(d.usdMint)];
  const vaults = [new PublicKey(d.brlVault), new PublicKey(d.usdVault)];
  const mine = [
    await createAssociatedTokenAccountIdempotent(connection, admin, mints[0], admin.publicKey, { commitment: "confirmed" }),
    await createAssociatedTokenAccountIdempotent(connection, admin, mints[1], admin.publicKey, { commitment: "confirmed" }),
  ];
  for (const [side, key] of [[0, "brl"], [1, "usd"]] as const) {
    const bal = BigInt((await connection.getTokenAccountBalance(vaults[side], "confirmed")).value.amount);
    const reserved = BigInt(pool.platformFees[side].toString()) + BigInt(pool.partnerFees[side].toString()) + BigInt(pool.lpFeesUnclaimed[side].toString());
    const free = Number(bal - reserved) / 1e6;
    if (free >= MIN_FREE[key]) {
      lines.push(`Liquidez livre ${key.toUpperCase()}: ${free.toLocaleString("pt-BR")} (ok)`);
      continue;
    }
    await program.methods
      .adminMint(side, u(REFILL[key]))
      .accountsPartial({ admin: admin.publicKey, pool: poolKey, mint: mints[side], destination: mine[side], mintAuthority: new PublicKey(d.mintAuthority), tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    const sig = await program.methods
      .deposit(BALEIA, side, u(REFILL[key]))
      .accountsPartial({
        user: admin.publicKey,
        pool: poolKey,
        position: positionPda(program.programId, poolKey, admin.publicKey, BALEIA, side),
        brlVault: vaults[0],
        usdVault: vaults[1],
        userBrl: mine[0],
        userUsd: mine[1],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    lines.push(`Liquidez livre ${key.toUpperCase()} estava em ${free.toLocaleString("pt-BR")}: admin repôs ${REFILL[key].toLocaleString("pt-BR")} como Baleia (${sig})`);
  }
  const adminSol = (await connection.getBalance(admin.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
  lines.push(`Admin: ${adminSol.toFixed(3)} SOL`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Manutenção da devnet\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
