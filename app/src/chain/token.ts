// As três instruções de token que o app usa, montadas à mão (sem @solana/spl-token, que puxa a biblioteca
// bigint-buffer, com vulnerabilidade conhecida). Layout conferido contra a spl-token em chain.test.ts.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const u64ix = (tag: number, amount: bigint) => {
  if (amount < 0n || amount >= 1n << 64n) throw new Error("Valor fora do limite");
  const b = new Uint8Array(9);
  b[0] = tag;
  new DataView(b.buffer).setBigUint64(1, amount, true);
  return b as Buffer;
};

/** Endereço da conta de token associada (ATA) de `owner` para `mint`. */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Cria a ATA se ainda não existir (não falha se já existe). */
export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1) as Buffer,
  });
}

export function mintToIx(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: u64ix(7, amount),
  });
}

export function transferIx(source: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: u64ix(3, amount),
  });
}
