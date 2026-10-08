// Cliente da cambI na Solana devnet: monta, assina e envia transações reais para o programa cambi_pool.
// Carregado sob demanda (import dinâmico), para não pesar a primeira abertura do app.
import "./polyfill";
import {
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAtaIdempotentIx,
  mintToIx,
  transferIx,
} from "./token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import deployment from "../devnet.json";
import sponsorFile from "./sponsor.json";
import {
  BRL,
  PoolRaw,
  PositionRaw,
  RENDE,
  USD,
  available,
  decodePoolRaw,
  decodePositionRaw,
  pendingFees,
  previewSwap,
} from "./accounts";
import { DISCRIMINATOR, PROGRAM_ERRORS } from "./idl";

const d = deployment as unknown as {
  rpc: string;
  programId: string | null;
  pool: string | null;
  brlMint: string | null;
  usdMint: string | null;
  brlVault: string | null;
  usdVault: string | null;
};

export const isDeployed = () => Boolean(d.programId && d.pool && d.brlMint && d.usdMint && d.brlVault && d.usdVault);

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Moedas de teste dadas a cada conta nova. */
export const FAUCET_BRL = 1_000;
/** SOL de devnet para a conta pagar as próprias taxas e o aluguel das contas que cria. */
const FAUCET_SOL = 0.02;

let _conn: Connection | null = null;
const conn = () => (_conn ??= new Connection(d.rpc, "confirmed"));

const ids = () => {
  if (!isDeployed()) throw new Error("Programa ainda não implantado na devnet");
  return {
    program: new PublicKey(d.programId!),
    pool: new PublicKey(d.pool!),
    mint: [new PublicKey(d.brlMint!), new PublicKey(d.usdMint!)],
    vault: [new PublicKey(d.brlVault!), new PublicKey(d.usdVault!)],
  };
};

const sponsor = () => Keypair.fromSecretKey(Uint8Array.from(sponsorFile.secretKey));

export const ata = (owner: PublicKey, side: number) => associatedTokenAddress(ids().mint[side], owner);

export function positionPda(owner: PublicKey, tranche: number, side: number) {
  const { program, pool } = ids();
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("position"), pool.toBytes(), owner.toBytes(), Uint8Array.of(tranche), Uint8Array.of(side)],
    program,
  )[0];
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

/* ---------- Quem assina ---------- */

export interface ChainSigner {
  kind: "local" | "phantom";
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

const LOCAL_KEY = "cambi-devnet-account-v1";

/** Conta criada no próprio aparelho (a "carteira invisível" da demo). */
export function localSigner(): ChainSigner {
  let kp: Keypair;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    kp = raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : Keypair.generate();
    if (!raw) localStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    kp = Keypair.generate(); // armazenamento bloqueado: conta vale só nesta sessão
  }
  return {
    kind: "local",
    publicKey: kp.publicKey,
    async signTransaction(tx) {
      tx.partialSign(kp);
      return tx;
    },
  };
}

export function forgetLocalAccount() {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignora */
  }
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: PublicKey;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export const phantomProvider = (): PhantomProvider | null => {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
};

/** Link que abre o app dentro do navegador da Phantom (celular sem a extensão). */
export const phantomBrowseLink = () =>
  `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;

export async function phantomSigner(): Promise<ChainSigner> {
  const p = phantomProvider();
  if (!p) throw new Error("Phantom não encontrada neste navegador");
  const { publicKey } = await p.connect();
  const pk = new PublicKey(publicKey.toString());
  return { kind: "phantom", publicKey: pk, signTransaction: (tx) => p.signTransaction(tx) };
}

/* ---------- Leitura ---------- */

export interface ChainState {
  owner: string;
  sol: number;
  balances: [bigint, bigint]; // cBRL, cUSD (6 casas)
  hasTokenAccounts: boolean;
  pool: PoolRaw;
  vaults: [bigint, bigint];
  avail: [bigint, bigint];
  positions: { side: number; raw: PositionRaw; pending: [bigint, bigint] }[];
}

const tokenAmount = (data: Uint8Array | null | undefined) =>
  data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : 0n;

export async function fetchState(owner: PublicKey): Promise<ChainState> {
  const { pool, vault } = ids();
  const keys = [pool, vault[0], vault[1], ata(owner, BRL), ata(owner, USD), positionPda(owner, RENDE, BRL), positionPda(owner, RENDE, USD)];
  const [infos, lamports] = await Promise.all([conn().getMultipleAccountsInfo(keys, "confirmed"), conn().getBalance(owner, "confirmed")]);
  if (!infos[0]) throw new Error("Pool não encontrado na devnet");
  const p = decodePoolRaw(infos[0].data);
  const vaults: [bigint, bigint] = [tokenAmount(infos[1]?.data), tokenAmount(infos[2]?.data)];
  const positions = [5, 6]
    .map((i, side) => ({ info: infos[i], side }))
    .filter((x) => x.info)
    .map(({ info, side }) => {
      const raw = decodePositionRaw(info!.data);
      return { side, raw, pending: pendingFees(p, raw) };
    });
  return {
    owner: owner.toBase58(),
    sol: lamports / LAMPORTS_PER_SOL,
    balances: [tokenAmount(infos[3]?.data), tokenAmount(infos[4]?.data)],
    hasTokenAccounts: Boolean(infos[3] && infos[4]),
    pool: p,
    vaults,
    avail: [available(p, vaults[0], BRL), available(p, vaults[1], USD)],
    positions,
  };
}

/* ---------- Envio ---------- */

function friendlyError(e: unknown): Error {
  const out = friendly(e);
  (out as Error & { cause?: unknown }).cause = e; // detalhe técnico preservado para depuração
  return out;
}

function friendly(e: unknown): Error {
  const err = e as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const text = [err.message ?? "", ...(err.logs ?? err.transactionLogs ?? [])].join("\n");
  const custom = text.match(/custom program error: 0x([0-9a-f]+)/i) ?? text.match(/Error Number: (\d+)/);
  if (custom) {
    const code = custom[0].includes("0x") ? parseInt(custom[1], 16) : Number(custom[1]);
    if (PROGRAM_ERRORS[code]) return new Error(PROGRAM_ERRORS[code]);
  }
  if (/User rejected|rejected the request/i.test(text)) return new Error("Você cancelou na carteira.");
  if (/insufficient lamports|insufficient funds for fee|Attempt to debit an account but found no record/i.test(text))
    return new Error("A conta está sem SOL de devnet para a taxa de rede. Toque em “Receber moedas de teste”.");
  if (/429|Too many requests/i.test(text)) return new Error("A rede de testes está ocupada. Tente de novo em alguns segundos.");
  if (/blockhash|expired|timeout/i.test(text)) return new Error("A rede demorou para confirmar. Confira a atividade e tente de novo.");
  return new Error(err.message?.split("\n")[0] || "Não foi possível concluir na blockchain.");
}

async function sendTx(ixs: TransactionInstruction[], feePayer: PublicKey, sign: (tx: Transaction) => Promise<Transaction>) {
  try {
    const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(...ixs);
    const signed = await sign(tx);
    const sig = await conn().sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
    const res = await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Transação falhou: ${JSON.stringify(res.value.err)}`);
    return sig;
  } catch (e) {
    throw friendlyError(e);
  }
}

const memo = (text: string, signer: PublicKey) =>
  new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: new TextEncoder().encode(text) as Buffer });

const u64le = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};

function programIx(name: keyof typeof DISCRIMINATOR, args: Uint8Array[], keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) {
  const data = new Uint8Array([...DISCRIMINATOR[name], ...args.flatMap((a) => Array.from(a))]);
  return new TransactionInstruction({ programId: ids().program, keys, data: data as Buffer });
}

const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

/**
 * Conta nova: o patrocinador da devnet cria as contas de token, dá R$ 1.000 de teste (cBRL) e um pouco de SOL
 * para as próximas taxas. A pessoa não assina nada aqui.
 */
export async function onboard(owner: PublicKey) {
  const sp = sponsor();
  const { mint } = ids();
  const ixs = [
    createAtaIdempotentIx(sp.publicKey, ata(owner, BRL), owner, mint[BRL]),
    createAtaIdempotentIx(sp.publicKey, ata(owner, USD), owner, mint[USD]),
    mintToIx(mint[BRL], ata(owner, BRL), sp.publicKey, BigInt(FAUCET_BRL) * 1_000_000n),
    SystemProgram.transfer({ fromPubkey: sp.publicKey, toPubkey: owner, lamports: Math.round(FAUCET_SOL * LAMPORTS_PER_SOL) }),
    memo("cambI: conta de teste criada (devnet)", sp.publicKey),
  ];
  return sendTx(ixs, sp.publicKey, async (tx) => {
    tx.partialSign(sp);
    return tx;
  });
}

export async function swap(signer: ChainSigner, s: ChainState, sideIn: number, amountIn: bigint) {
  const { pool, vault, program } = ids();
  const { q, blocker, kind } = previewSwap(s, sideIn, amountIn);
  if (blocker) throw new Error(blocker);
  const owner = signer.publicKey;
  const pos = kind === "depositor" ? positionPda(owner, RENDE, s.positions.find((p) => p.raw.amount > 0n)!.side) : program;
  const minOut = (q.amountOut * 995n) / 1000n; // aceita até 0,5% de variação entre a prévia e a execução
  const ix = programIx("swap", [Uint8Array.of(sideIn), u64le(amountIn), u64le(minOut)], [
    { pubkey: owner, isSigner: true, isWritable: false },
    w(pool),
    w(vault[BRL]),
    w(vault[USD]),
    w(ata(owner, BRL)),
    w(ata(owner, USD)),
    r(pos), // depositor_position (opcional: o próprio programa quando ausente)
    r(program), // partner (ausente)
    r(TOKEN_PROGRAM_ID),
  ]);
  const sig = await sendTx([ix], owner, signer.signTransaction);
  return { sig, q, kind };
}

export async function depositRende(signer: ChainSigner, side: number, amount: bigint) {
  const { pool, vault } = ids();
  const owner = signer.publicKey;
  const ix = programIx("deposit", [Uint8Array.of(RENDE), Uint8Array.of(side), u64le(amount)], [
    { pubkey: owner, isSigner: true, isWritable: true },
    w(pool),
    w(positionPda(owner, RENDE, side)),
    w(vault[BRL]),
    w(vault[USD]),
    w(ata(owner, BRL)),
    w(ata(owner, USD)),
    r(TOKEN_PROGRAM_ID),
    r(SystemProgram.programId),
  ]);
  return sendTx([ix], owner, signer.signTransaction);
}

/** Saca `amount` do principal e recebe as taxas acumuladas (amount = 0 só colhe as taxas). */
export async function withdrawRende(signer: ChainSigner, side: number, amount: bigint) {
  const { pool, vault } = ids();
  const owner = signer.publicKey;
  const ix = programIx("withdraw", [u64le(amount)], [
    { pubkey: owner, isSigner: true, isWritable: false },
    w(pool),
    w(positionPda(owner, RENDE, side)),
    w(vault[BRL]),
    w(vault[USD]),
    w(ata(owner, BRL)),
    w(ata(owner, USD)),
    r(TOKEN_PROGRAM_ID),
  ]);
  return sendTx([ix], owner, signer.signTransaction);
}

/**
 * Saída do dinheiro. USDC: vai direto para a carteira de destino. Pix e conta nos EUA: vai para o parceiro
 * (na devnet, a carteira patrocinadora faz esse papel) com um memo do destino, e o parceiro paga a outra ponta.
 */
export async function sendOut(signer: ChainSigner, side: number, amount: bigint, route: "pix" | "ach" | "usdc", destination: string, note: string) {
  const owner = signer.publicKey;
  const { mint } = ids();
  const to = route === "usdc" ? new PublicKey(destination) : sponsor().publicKey;
  const toAta = ata(to, side);
  const ixs = [
    createAtaIdempotentIx(owner, toAta, to, mint[side]),
    transferIx(ata(owner, side), toAta, owner, amount),
    memo(`cambI: ${note}`.slice(0, 180), owner),
  ];
  return sendTx(ixs, owner, signer.signTransaction);
}
