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
