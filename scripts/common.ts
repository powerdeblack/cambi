// Utilitários compartilhados entre os testes de integração e o script de devnet.
import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccount, createMint, mintTo } from "@solana/spl-token";
import { ConfirmOptions, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

/** Espera confirmação antes de seguir: a próxima transação precisa enxergar a conta criada. */
const CONFIRMED: ConfirmOptions = { commitment: "confirmed", preflightCommitment: "confirmed" };

export const DECIMALS = 6;
export const BRL = 0;
export const USD = 1;
export const RENDE = 0;
export const BALEIA = 1;

/** Converte unidades (ex.: 10,5 reais) para a menor unidade do token (6 casas). */
export const u = (amount: number) => new anchor.BN(Math.round(amount * 10 ** DECIMALS));
export const fromUnits = (v: anchor.BN | bigint | number) => Number(v.toString()) / 10 ** DECIMALS;

export function poolPda(programId: PublicKey, brlMint: PublicKey, usdMint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), brlMint.toBuffer(), usdMint.toBuffer()], programId)[0];
}

export function vaultPda(programId: PublicKey, pool: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), pool.toBuffer(), mint.toBuffer()], programId)[0];
}

export function positionPda(programId: PublicKey, pool: PublicKey, owner: PublicKey, tranche: number, side: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), owner.toBuffer(), Buffer.from([tranche]), Buffer.from([side])],
    programId,
  )[0];
}

/** Conta de dados do programa (BPF upgradeable): guarda quem é a autoridade de upgrade. */
export function programDataPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
}

/** Autoridade de emissão das moedas de teste (faucet de devnet), um PDA do programa. */
export function mintAuthorityPda(programId: PublicKey, pool: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("mint-authority"), pool.toBuffer()], programId)[0];
}

export function claimPda(programId: PublicKey, pool: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("claim"), pool.toBuffer(), user.toBuffer()], programId)[0];
}

export function partnerPda(programId: PublicKey, pool: PublicKey, authority: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("partner"), pool.toBuffer(), authority.toBuffer()], programId)[0];
}

export interface Mints {
  brl: PublicKey;
  usd: PublicKey;
}

export async function createMints(connection: Connection, authority: Keypair): Promise<Mints> {
  const brl = await createMint(connection, authority, authority.publicKey, null, DECIMALS, undefined, CONFIRMED);
  const usd = await createMint(connection, authority, authority.publicKey, null, DECIMALS, undefined, CONFIRMED);
  return { brl, usd };
}

export interface User {
  kp: Keypair;
  brl: PublicKey;
  usd: PublicKey;
}

/** Cria (ou reaproveita) um usuário com contas de token nas duas moedas e saldo inicial. */
export async function setupUser(
  connection: Connection,
  mintAuthority: Keypair,
  mints: Mints,
  balances: { brl: number; usd: number },
  opts: { kp?: Keypair; airdropSol?: number } = {},
): Promise<User> {
  const kp = opts.kp ?? Keypair.generate();
  if (opts.airdropSol) {
    const sig = await connection.requestAirdrop(kp.publicKey, opts.airdropSol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
  const brl = await createAssociatedTokenAccount(connection, mintAuthority, mints.brl, kp.publicKey, CONFIRMED);
  const usd = await createAssociatedTokenAccount(connection, mintAuthority, mints.usd, kp.publicKey, CONFIRMED);
  if (balances.brl > 0) await mintTo(connection, mintAuthority, mints.brl, brl, mintAuthority, BigInt(u(balances.brl).toString()), [], CONFIRMED);
  if (balances.usd > 0) await mintTo(connection, mintAuthority, mints.usd, usd, mintAuthority, BigInt(u(balances.usd).toString()), [], CONFIRMED);
  return { kp, brl, usd };
}

export async function tokenBalance(connection: Connection, account: PublicKey) {
  const b = await connection.getTokenAccountBalance(account, "confirmed");
  return Number(b.value.uiAmount ?? 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A RPC pública da devnet limita requisições (HTTP 429). Este fetch espaça as chamadas e,
 * quando recebe 429, espera e tenta de novo. Uma requisição recusada com 429 não foi
 * processada, então repetir é seguro (inclusive para envio de transações).
 */
let lastCall = 0;
const MIN_GAP_MS = 250;
export async function politeFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    lastCall = Math.max(Date.now(), lastCall + MIN_GAP_MS);
    if (wait > 0) await sleep(wait);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 12) return res;
    const backoff = Math.min(2_000 * attempt, 15_000);
    console.log(`RPC pediu calma (429). Nova tentativa em ${backoff / 1000}s…`);
    await sleep(backoff);
  }
}

/** Conexão com a RPC pública que respeita o limite de requisições. */
export function politeConnection(endpoint: string) {
  return new Connection(endpoint, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: politeFetch as typeof fetch });
}
