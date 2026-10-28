// Chaves de TESTE derivadas da chave do deployer (devnet): conselho, Baleias, Rende e endereços dos programas v2.6.
// Assim nenhuma chave de teste depende de um cache próprio (o cache das chaves do v2.5 expirou e levou a governança
// junto). Só a chave do deployer precisa existir, e o oráculo da v1 já a usa a cada 15 minutos.
// Nunca usar para dinheiro real: quem tem a chave do deployer tem todas estas.
//
// Uso: ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/derive-key.ts <rótulo> <arquivo de saída>
import { Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";

export function deriveKey(deployer: Keypair, label: string): Keypair {
  const seed = createHash("sha256").update(Buffer.from(deployer.secretKey)).update(`cambi-devnet-v26:${label}`).digest();
  return Keypair.fromSeed(seed);
}

export function loadDeployer(path = process.env.ANCHOR_WALLET!): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

if (process.argv[1]?.endsWith("derive-key.ts") && process.argv[2] && process.argv[3]) {
  const kp = deriveKey(loadDeployer(), process.argv[2]);
  writeFileSync(process.argv[3], JSON.stringify(Array.from(kp.secretKey)));
  console.log(`${process.argv[2]}: ${kp.publicKey.toBase58()}`);
}
