// Cliente da cambI na Solana devnet: monta, assina e envia transações reais para o programa cambi_pool.
// Carregado sob demanda (import dinâmico), para não pesar a primeira abertura do app.
import "./polyfill";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import deployment from "../devnet.json";
import { TOKEN_PROGRAM_ID, associatedTokenAddress, createAtaIdempotentIx, transferCheckedIx } from "./token";
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

export { Keypair };

const d = deployment as unknown as {
  cluster: string;
  rpc: string;
  payout?: string | null;
  programId: string | null;
  pool: string | null;
  brlMint: string | null;
  usdMint: string | null;
  brlVault: string | null;
  usdVault: string | null;
};

export const isDeployed = () =>
  Boolean(d.cluster === "devnet" && d.programId && d.pool && d.brlMint && d.usdMint && d.brlVault && d.usdVault && d.payout);

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Hash do bloco gênese da devnet: o app só assina se a RPC for mesmo a devnet. */
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DECIMALS = 6;
/** Moedas de teste por pedido ao faucet do programa (regras on-chain: 1x por hora, só com saldo baixo). */
export const FAUCET_BRL = 1_000;
/** SOL mínimo para pagar as taxas e o aluguel das contas que a pessoa cria. */
export const MIN_SOL = 0.01;

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

let genesisOk: Promise<void> | null = null;
/** Recusa assinar qualquer coisa se a rede não for a devnet (proteção contra RPC trocada). */
const assertDevnet = () =>
  (genesisOk ??= conn()
    .getGenesisHash()
    .then((h) => {
      if (h !== DEVNET_GENESIS) throw new Error("A rede conectada não é a devnet da Solana. Por segurança, nada foi assinado.");
    })
    .catch((e) => {
      genesisOk = null;
      throw e;
    }));

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

/** Só o objeto injetado pela própria Phantom (window.phantom.solana); não confia em window.solana genérico. */
export const phantomProvider = (): PhantomProvider | null => {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider } };
  const p = w.phantom?.solana;
  return p?.isPhantom ? p : null;
};

/** Link que abre o app dentro do navegador da Phantom (celular sem a extensão). */
export const phantomBrowseLink = () =>
  `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;

/** `silent`: reconecta só se a pessoa já autorizou antes (não abre janela da carteira sozinho). */
export async function phantomSigner(silent = false): Promise<ChainSigner> {
  const p = phantomProvider();
  if (!p) throw new Error("Phantom não encontrada neste navegador");
  const { publicKey } = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
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
    return new Error("A conta está sem SOL de devnet para a taxa de rede. Use “Receber moedas de teste”.");
  if (/429|Too many requests/i.test(text)) return new Error("A rede de testes está ocupada. Tente de novo em alguns segundos.");
  if (/blockhash|expired|timeout/i.test(text)) return new Error("A rede demorou para confirmar. Confira a atividade e tente de novo.");
  return new Error(err.message?.split("\n")[0] || "Não foi possível concluir na blockchain.");
}

async function sendTx(ixs: TransactionInstruction[], feePayer: PublicKey, sign: (tx: Transaction) => Promise<Transaction>) {
  try {
    await assertDevnet();
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

export function mintAuthorityPda() {
  const { program, pool } = ids();
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("mint-authority"), pool.toBytes()], program)[0];
}

export function claimPda(owner: PublicKey) {
  const { program, pool } = ids();
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("claim"), pool.toBytes(), owner.toBytes()], program)[0];
}

/** Erro especial: a conta precisa de SOL de devnet e o faucet público da Solana não respondeu. */
export class NeedSolError extends Error {
  constructor(public address: string) {
    super("Sua conta precisa de um pouco de SOL de teste para as taxas da rede.");
  }
}

/**
 * Garante SOL de devnet para as taxas: tenta o faucet público da Solana (airdrop). Se ele estiver limitado,
 * lança NeedSolError para a tela mostrar o endereço e o link do faucet. Nenhuma chave da cambI paga nada.
 */
export async function ensureSol(owner: PublicKey) {
  await assertDevnet();
  const bal = (await conn().getBalance(owner, "confirmed")) / LAMPORTS_PER_SOL;
  if (bal >= MIN_SOL) return bal;
  try {
    const sig = await conn().requestAirdrop(owner, 0.5 * LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash("confirmed");
    await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  } catch {
    throw new NeedSolError(owner.toBase58());
  }
  const after = (await conn().getBalance(owner, "confirmed")) / LAMPORTS_PER_SOL;
  if (after < MIN_SOL) throw new NeedSolError(owner.toBase58());
  return after;
}

/**
 * Moedas de teste pelo faucet DO PROGRAMA (regras na blockchain: 1 vez por hora, só para quem tem menos de
 * R$ 100, teto global por hora). Cria as contas de token da pessoa, se ainda não existirem. Ela assina e paga
 * a taxa (centavos de SOL de teste).
 */
export async function faucetClaim(signer: ChainSigner) {
  const { pool, mint } = ids();
  const owner = signer.publicKey;
  const ixs = [
    createAtaIdempotentIx(owner, ata(owner, BRL), owner, mint[BRL]),
    createAtaIdempotentIx(owner, ata(owner, USD), owner, mint[USD]),
    programIx("faucet_claim", [], [
      { pubkey: owner, isSigner: true, isWritable: true },
      w(pool),
      w(claimPda(owner)),
      w(mint[BRL]),
      w(ata(owner, BRL)),
      r(mintAuthorityPda()),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ]),
  ];
  return sendTx(ixs, owner, signer.signTransaction);
}

/**
 * Troca. `confirmedOut` é o valor que a pessoa VIU e confirmou: o mínimo aceito (slippage) é 99,5% dele,
 * não da cotação recalculada na hora (que poderia ter piorado sem ela ver).
 */
export async function swap(signer: ChainSigner, s: ChainState, sideIn: number, amountIn: bigint, confirmedOut: bigint) {
  const { pool, vault, program } = ids();
  const { q, blocker, kind } = previewSwap(s, sideIn, amountIn);
  if (blocker) throw new Error(blocker);
  const minOut = (confirmedOut * 995n) / 1000n;
  if (q.amountOut < minOut) throw new Error("A cotação mudou desde a prévia. Confira o novo valor e confirme de novo.");
  const owner = signer.publicKey;
  const pos = kind === "depositor" ? positionPda(owner, RENDE, s.positions.find((p) => p.raw.amount > 0n)!.side) : program;
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
 * Saída do dinheiro. USDC: vai direto para a carteira de destino (só carteiras de verdade, não endereços de
 * programa). Pix e conta nos EUA: vai para a carteira do parceiro, com um memo que tem SÓ um código de
 * referência (nenhum dado pessoal na blockchain); o parceiro paga a outra ponta.
 */
export async function sendOut(signer: ChainSigner, side: number, amount: bigint, route: "pix" | "ach" | "usdc", destination: string, reference: string) {
  const owner = signer.publicKey;
  const { mint } = ids();
  let to: PublicKey;
  if (route === "usdc") {
    to = new PublicKey(destination);
    if (!PublicKey.isOnCurve(to.toBytes())) throw new Error("Esse endereço não é uma carteira (é de programa ou conta de token). Confira o destino.");
    if (to.equals(owner)) throw new Error("O destino é a sua própria conta.");
  } else {
    to = new PublicKey(d.payout!);
  }
  const toAta = ata(to, side);
  const ixs = [
    createAtaIdempotentIx(owner, toAta, to, mint[side]),
    transferCheckedIx(ata(owner, side), mint[side], toAta, owner, amount, DECIMALS),
    memo(`cambI ref ${reference.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24)}`, owner),
  ];
  return sendTx(ixs, owner, signer.signTransaction);
}
