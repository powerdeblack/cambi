// Pool do PROGRAMA v2.6 (branch v2): guardião sem chave, travas com hora para acabar, reserva da Rende e fila
// que paga na outra moeda. Substitui o pool v2.5, que ficou sem governança quando o cache das chaves de teste expirou
// (o programa e o pool avaliados, e os pools antigos, não são tocados).
//
// Primeira execução (sem deployments/devnet-v26.json):
//   - conselho de teste: multisig Squads 7 de 10 com chaves de teste NOVAS (separadas das Baleias);
//   - moedas de teste, pool no programa v2.6, limites e regras de segurança;
//   - o deployer, no papel do parceiro regulado, dá credencial às Baleias de teste e à Rende, que depositam;
//   - guardião = PDA do programa guardião (ninguém tem chave de pausa); ficha de vigília criada;
//   - o conselho assume admin e oráculo e valida a primeira cotação.
// A autoridade de upgrade fica com o deployer na devnet (a v3 final é imutável; ver white paper).
// Execuções seguintes: rodada de cotação validada pelo conselho (a cotação vale 24 h).
//
// Uso (GitHub Actions): ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/pool-v26.ts
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fetchConsensusQuote } from "../app/src/quote";
import { BALEIA, BRL, RENDE, USD, credentialPda, mintAuthorityPda, poolPda, positionPda, programDataPda, u, vaultPda } from "./common";
import { deriveKey } from "./derive-key";

const RPC = "https://api.devnet.solana.com";
const FILE = "deployments/devnet-v26.json";
const MEMBERS = 10;
const THRESHOLD = 7;
const SAFETY = { window: 3_600, breakerBps: 3_000, instantBps: 1_000, notice: 600, limits: [10_000, 100_000, 0] };
const MAX_PRICE_AGE = 86_400;
const MAX_PRICE_MOVE_BPS = 1_000;
const LOCKUP_SECS = 600;
const PRICE_SCALE = 1_000_000;
const DECIMALS = 6;
const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function slowFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 400 - Date.now();
    lastCall = Math.max(Date.now(), lastCall + 400);
    if (wait > 0) await sleep(wait);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 25) return res;
    await sleep(Math.min(3_000 * attempt, 30_000));
  }
}
const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: slowFetch as typeof fetch });

let payer: Keypair;
/** Envia (o deployer paga a taxa) e confirma consultando o status. */
async function send(ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const seen = new Set<string>([payer.publicKey.toBase58()]);
  tx.sign(payer, ...signers.filter((s) => !seen.has(s.publicKey.toBase58()) && seen.add(s.publicKey.toBase58())));
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Transação falhou ${sig}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`Sem confirmação depois de 2 minutos: ${sig}`);
}

interface Validation {
  index: number;
  action: string;
  at: string;
  approvals: number;
  createSignature: string;
  approveSignature: string;
  executeSignature: string;
}

/** Proposta do conselho de teste: cria, 7 aprovam juntas e executa. O deployer paga taxas e aluguel. */
async function validate(msPda: PublicKey, council: Keypair[], ix: TransactionInstruction, action: string): Promise<Validation> {
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
  const transactionIndex = BigInt(Number(info.transactionIndex) + 1);
  const signers = council.slice().sort(() => Math.random() - 0.5).slice(0, THRESHOLD);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const createSignature = await send(
    [
      multisig.instructions.vaultTransactionCreate({
        multisigPda: msPda,
        transactionIndex,
        creator: signers[0].publicKey,
        rentPayer: payer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [ix] }),
        memo: `cambI: ${action}`.slice(0, 80),
      }),
      multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex, creator: signers[0].publicKey, rentPayer: payer.publicKey }),
    ],
    [signers[0]],
  );
  const approveSignature = await send(
    signers.map((m) => multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex, member: m.publicKey })),
    signers,
  );
  const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex, member: signers[0].publicKey });
  const executeSignature = await send([instruction], [signers[0]]);
  console.log(`${action}: proposta ${transactionIndex}, ${THRESHOLD} aprovações, executada ${executeSignature}`);
  return { index: Number(transactionIndex), action, at: new Date().toISOString(), approvals: THRESHOLD, createSignature, approveSignature, executeSignature };
}

async function main() {
  payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new Program(JSON.parse(readFileSync("idl/cambi_pool_v26.json", "utf8")) as Idl, provider);
  const guardianProgram = new Program(JSON.parse(readFileSync("idl/cambi_guardian.json", "utf8")) as Idl, provider);
  const pid = program.programId;
  // Chaves de teste derivadas da chave do deployer: nenhuma depende de cache próprio.
  const council = Array.from({ length: MEMBERS }, (_, i) => deriveKey(payer, `conselho-${i + 1}`));
  const baleias = Array.from({ length: MEMBERS }, (_, i) => deriveKey(payer, `baleia-${i + 1}`));
  const rende = deriveKey(payer, "rende");
  const councilCreateKey = deriveKey(payer, "conselho-create");
  console.log(`Deployer ${payer.publicKey.toBase58()}: ${(await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  let price = 5.0;
  let source = "reserva fixa";
  let agree = true;
  try {
    const q = await fetchConsensusQuote();
    price = q.price;
    source = q.used.map((x) => `${x.source} ${x.price.toFixed(4)}`).join(", ");
    agree = q.used.filter((x) => Math.abs(x.price / q.price - 1) <= 0.003).length >= 2;
  } catch (e) {
    console.log(`Consenso indisponível, usando ${price}: ${(e as Error).message}`);
  }
  const priceRaw = new anchor.BN(Math.round(price * PRICE_SCALE));
  const [msPda] = multisig.getMultisigPda({ createKey: councilCreateKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });

  // ---------------- Rodada de cotação (pool já existe) ----------------
  if (existsSync(FILE)) {
    const dep = JSON.parse(readFileSync(FILE, "utf8"));
    if (dep.council.multisig !== msPda.toBase58()) throw new Error("Chaves do conselho de teste não batem com o registro (chave do deployer trocada?)");
    if (!agree) throw new Error(`Menos de 2 fontes concordam a até 0,3%; cotação não proposta: ${source}`);
    const pool = new PublicKey(dep.pool);
    const old = Number((await (program.account as any).pool.fetch(pool)).price.toString()) / PRICE_SCALE;
    if (Math.abs(price / old - 1) > 0.1) throw new Error(`Variação acima de 10% (${old} → ${price}); cotação não proposta.`);
    const v = await validate(msPda, council, await program.methods.setPrice(priceRaw).accountsPartial({ oracle: vault, pool }).instruction(), `Cotação R$ ${old.toFixed(4)} → R$ ${price.toFixed(4)} (${source})`);
    dep.council.validations = [v, ...dep.council.validations].slice(0, 30);
    dep.updatedAt = new Date().toISOString();
    writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
    summary(dep);
    return;
  }

  // ---------------- Montagem ----------------
  const txs: { label: string; signature: string }[] = [];
  const log = (label: string, signature: string) => {
    txs.push({ label, signature });
    console.log(`${label}: ${signature}`);
  };
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  log(
    `Conselho de teste criado (${THRESHOLD} de ${MEMBERS}, chaves separadas das Baleias)`,
    await send(
      [
        multisig.instructions.multisigCreateV2({
          treasury: programConfig.treasury,
          creator: payer.publicKey,
          multisigPda: msPda,
          configAuthority: null,
          threshold: THRESHOLD,
          members: council.map((m) => ({ key: m.publicKey, permissions: multisig.types.Permissions.all() })),
          timeLock: 0,
          createKey: councilCreateKey.publicKey,
          rentCollector: null,
        }),
      ],
      [councilCreateKey],
    ),
  );

  const brlMint = Keypair.generate();
  const usdMint = Keypair.generate();
  const pool = poolPda(pid, brlMint.publicKey, usdMint.publicKey);
  const brlVault = vaultPda(pid, pool, brlMint.publicKey);
  const usdVault = vaultPda(pid, pool, usdMint.publicKey);
  const mintAuthority = mintAuthorityPda(pid, pool);
  const mintRent = await getMinimumBalanceForRentExemptMint(connection);
  const mintIxs = (m: Keypair) => [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: m.publicKey, space: MINT_SIZE, lamports: mintRent, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(m.publicKey, DECIMALS, payer.publicKey, null),
    createSetAuthorityInstruction(m.publicKey, payer.publicKey, AuthorityType.MintTokens, mintAuthority),
  ];
  log("Moedas de teste (cBRL e cUSD)", await send([...mintIxs(brlMint), ...mintIxs(usdMint)], [brlMint, usdMint]));
  log(
    `Pool v2.6 criado (R$ ${price.toFixed(4)} por dólar): KYC exigido, disjuntor 30%/h, saque imediato até 10%, fila com 10 min de aviso, reserva da Rende 30%`,
    await send([
      await program.methods
        .initialize(priceRaw, new anchor.BN(MAX_PRICE_AGE))
        .accountsPartial({
          admin: payer.publicKey,
          brlMint: brlMint.publicKey,
          usdMint: usdMint.publicKey,
          pool,
          brlVault,
          usdVault,
          program: pid,
          programData: programDataPda(pid),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await program.methods.setLimits(new anchor.BN(MAX_PRICE_AGE), MAX_PRICE_MOVE_BPS, new anchor.BN(LOCKUP_SECS)).accountsPartial({ admin: payer.publicKey, pool }).instruction(),
      await program.methods
        .setSafety(new anchor.BN(SAFETY.window), SAFETY.breakerBps, SAFETY.instantBps, new anchor.BN(SAFETY.notice), SAFETY.limits.map((v) => u(v)))
        .accountsPartial({ admin: payer.publicKey, pool })
        .instruction(),
    ]),
  );

  const atas = (owner: PublicKey) => ({ brl: getAssociatedTokenAddressSync(brlMint.publicKey, owner), usd: getAssociatedTokenAddressSync(usdMint.publicKey, owner) });
  const ataIxs = (owner: PublicKey) => [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, atas(owner).brl, owner, brlMint.publicKey),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, atas(owner).usd, owner, usdMint.publicKey),
  ];
  const mintTo = (side: number, amount: number, destination: PublicKey) =>
    program.methods
      .adminMint(side, u(amount))
      .accountsPartial({ admin: payer.publicKey, pool, mint: side === BRL ? brlMint.publicKey : usdMint.publicKey, destination, mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
  const credentialIx = (user: PublicKey, level: number) =>
    program.methods
      .issueCredential(level, new anchor.BN(Math.floor(Date.now() / 1000) + 365 * 86_400))
      .accountsPartial({ issuer: payer.publicKey, pool, user, credential: credentialPda(pid, pool, user), systemProgram: SystemProgram.programId })
      .instruction();
  const depositIx = (user: PublicKey, tranche: number, side: number, amount: number) =>
    program.methods
      .deposit(tranche, side, u(amount))
      .accountsPartial({
        user,
        pool,
        position: positionPda(pid, pool, user, tranche, side),
        brlVault,
        usdVault,
        userBrl: atas(user).brl,
        userUsd: atas(user).usd,
        credential: credentialPda(pid, pool, user),
        brlMint: brlMint.publicKey,
        usdMint: usdMint.publicKey,
        brlReserve: null,
        usdReserve: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  // A posição é paga pela própria carteira: ela recebe o aluguel exato antes.
  const positionRent = await connection.getMinimumBalanceForRentExemption((program.account as any).position.size);
  const fund = (k: PublicKey, n: number) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k, lamports: n * positionRent + 1_000_000 });

  const sizes = [20_000, 15_000, 12_000, 10_000, 10_000, 8_000, 8_000, 6_000, 6_000, 5_000];
  for (const [i, b] of baleias.entries()) {
    const usd = Math.round(sizes[i] / price);
    log(
      `Baleia de teste ${i + 1} deposita R$ ${sizes[i].toLocaleString("pt-BR")} + US$ ${usd.toLocaleString("pt-BR")}`,
      await send(
        [
          fund(b.publicKey, 2),
          ...ataIxs(b.publicKey),
          await credentialIx(b.publicKey, 3),
          await mintTo(BRL, sizes[i], atas(b.publicKey).brl),
          await mintTo(USD, usd, atas(b.publicKey).usd),
          await depositIx(b.publicKey, BALEIA, BRL, sizes[i]),
          await depositIx(b.publicKey, BALEIA, USD, usd),
        ],
        [b],
      ),
    );
  }
  log(
    "Depósito Rende de teste: R$ 50.000 (credencial nível 2)",
    await send([fund(rende.publicKey, 1), ...ataIxs(rende.publicKey), await credentialIx(rende.publicKey, 2), await mintTo(BRL, 50_000, atas(rende.publicKey).brl), await depositIx(rende.publicKey, RENDE, BRL, 50_000)], [rende]),
  );

  // Guardião: o PDA do programa guardião. Ninguém tem chave de pausa.
  const [guardian] = PublicKey.findProgramAddressSync([Buffer.from("guardian"), pool.toBuffer()], guardianProgram.programId);
  const [watch] = PublicKey.findProgramAddressSync([Buffer.from("watch"), pool.toBuffer()], guardianProgram.programId);
  log(
    "Guardião = programa guardião (sem chave); ficha de vigília criada; oráculo e admin passam ao conselho",
    await send([
      await program.methods.setGuardian(guardian).accountsPartial({ admin: payer.publicKey, pool }).instruction(),
      await guardianProgram.methods.initWatch().accountsPartial({ payer: payer.publicKey, pool, watch, brlVault, usdVault, systemProgram: SystemProgram.programId }).instruction(),
      await program.methods.setOracle(vault).accountsPartial({ admin: payer.publicKey, pool }).instruction(),
      await program.methods.proposeAdmin(vault).accountsPartial({ admin: payer.publicKey, pool }).instruction(),
    ]),
  );
  const validations: Validation[] = [];
  validations.unshift(await validate(msPda, council, await program.methods.acceptAdmin().accountsPartial({ newAdmin: vault, pool }).instruction(), "Conselho assume o admin do pool"));
  validations.unshift(await validate(msPda, council, await program.methods.setPrice(priceRaw).accountsPartial({ oracle: vault, pool }).instruction(), `Primeira cotação: R$ ${price.toFixed(4)} (${source})`));
  const after = await (program.account as any).pool.fetch(pool);
  if (!after.admin.equals(vault) || !after.oracle.equals(vault) || !after.guardian.equals(guardian)) throw new Error("Admin, oráculo ou guardião não ficaram onde deviam");

  const dep = {
    cluster: "devnet",
    version: "2.6",
    rpc: RPC,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    programId: pid.toBase58(),
    guardianProgramId: guardianProgram.programId.toBase58(),
    pool: pool.toBase58(),
    brlMint: brlMint.publicKey.toBase58(),
    usdMint: usdMint.publicKey.toBase58(),
    brlVault: brlVault.toBase58(),
    usdVault: usdVault.toBase58(),
    mintAuthority: mintAuthority.toBase58(),
    guardian: guardian.toBase58(),
    watch: watch.toBase58(),
    admin: vault.toBase58(),
    oracle: vault.toBase58(),
    upgradeAuthority: payer.publicKey.toBase58(),
    upgradeAuthorityNote: "Na devnet o upgrade fica com o deployer; a v3 final será imutável depois das auditorias.",
    council: {
      note: "Conselho de TESTE (chaves de teste derivadas da chave do deployer), no papel do conselho misto de produção.",
      squadsProgram: multisig.PROGRAM_ID.toBase58(),
      multisig: msPda.toBase58(),
      vault: vault.toBase58(),
      threshold: THRESHOLD,
      members: council.map((m) => m.publicKey.toBase58()),
      validations,
    },
    liquidity: { baleias: sizes.map((s) => ({ brl: s, usd: Math.round(s / price) })), rendeBRL: 50_000 },
    security: {
      kycIssuer: payer.publicKey.toBase58(),
      kycIssuerNote: "Na devnet o deployer simula o parceiro regulado que faz o KYC.",
      levelLimitsBRL: SAFETY.limits,
      breaker: { windowSecs: SAFETY.window, bps: SAFETY.breakerBps },
      instantWithdrawBps: SAFETY.instantBps,
      withdrawNoticeSecs: SAFETY.notice,
      rendeReserveBps: 3_000,
    },
    transactions: txs.map((t) => ({ ...t, url: explorer("tx", t.signature) })),
    links: { program: explorer("address", pid.toBase58()), guardian: explorer("address", guardianProgram.programId.toBase58()), pool: explorer("address", pool.toBase58()), council: explorer("address", msPda.toBase58()) },
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
  summary(dep);
}

function summary(dep: any) {
  const rows = dep.council.validations.map((v: Validation) => `| #${v.index} | ${v.action} | ${v.approvals} de 10 | [executada](${explorer("tx", v.executeSignature)}) |`).join("\n");
  const text = `## Programa v2.6 + guardião (devnet)\n\n- Pool: [${dep.pool}](${dep.links.pool})\n- Guardião (programa, sem chave): [${dep.guardianProgramId}](${dep.links.guardian})\n- Conselho de teste: [${dep.council.multisig}](${dep.links.council})\n\n| Proposta | Ação | Assinaturas | Prova |\n|---|---|---|---|\n${rows}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
