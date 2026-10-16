// Pool do PROGRAMA v2 (branch v2): programa novo, com KYC on-chain, disjuntor, fila de saque, guardião e prova de reserva.
// O programa e o pool avaliados (deployments/devnet.json) e o pool do consórcio no programa antigo não são tocados.
//
// Primeira execução (sem deployments/devnet-v2.json):
//   - moedas de teste, pool no programa v2, limites e regras de segurança;
//   - o emissor de KYC (aqui o deployer, simulando o parceiro regulado) dá credencial às 10 Baleias e à Rende;
//   - as mesmas 10 Baleias do consórcio depositam, e a MESMA multisig 7 de 10 assume admin e oráculo;
//   - guardião (só pausa) = chave de plantão do deployer;
//   - multisig de UPGRADE (mesmas Baleias, 7 de 10, prazo de espera) vira a autoridade de upgrade do programa.
// Execuções seguintes: rodada de cotação validada pela multisig.
//
// Uso (GitHub Actions): ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/consortium-v2.ts
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
import idl from "../idl/cambi_pool_v2.json";
import { BALEIA, BRL, RENDE, USD, credentialPda, mintAuthorityPda, poolPda, positionPda, programDataPda, u, vaultPda } from "./common";

const RPC = "https://api.devnet.solana.com";
const FILE = "deployments/devnet-v2.json";
/** Consórcio já existente (mesmas Baleias e mesma multisig de governança). */
const CONSORTIUM_FILE = "deployments/devnet-consortium.json";
/** Prazo de espera da multisig de upgrade: aprovada a atualização, ela só pode ser executada depois disso. */
const UPGRADE_TIMELOCK_SECS = 3_600;
/** Regras de segurança na devnet (aviso prévio curto para dar para testar no app). */
const SAFETY = { window: 3_600, breakerBps: 3_000, instantBps: 1_000, notice: 600, limits: [10_000, 100_000, 0] };
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const KEYS = ".consortium-keys";
const MEMBERS = 10;
const THRESHOLD = 7;
const MAX_PRICE_AGE = 86_400; // sem cron neste branch: a cotação vale 24 h (limite do programa)
const MAX_PRICE_MOVE_BPS = 1_000;
const LOCKUP_SECS = 600;
const PRICE_SCALE = 1_000_000;
const DECIMALS = 6;
const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- RPC educada: espaça as chamadas e espera bastante quando recebe 429 ----------
let lastCall = 0;
async function slowFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 700 - Date.now();
    lastCall = Math.max(Date.now(), lastCall + 700);
    if (wait > 0) await sleep(wait);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 25) return res;
    const backoff = Math.min(3_000 * attempt, 30_000);
    console.log(`RPC pediu calma (429). Nova tentativa em ${backoff / 1000}s…`);
    await sleep(backoff);
  }
}
const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: slowFetch as typeof fetch });

/** Envia uma transação (o primeiro assinante paga) e confirma consultando o status, sem websocket. */
async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const seen = new Set<string>();
  tx.sign(...signers.filter((s) => !seen.has(s.publicKey.toBase58()) && seen.add(s.publicKey.toBase58())));
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
  proposer: string;
  approvals: { member: string; signature: string }[];
  createSignature: string;
  executeSignature: string;
}

function loadOrCreate(path: string): Keypair {
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/** As 10 Baleias: chaves próprias, guardadas só no cache do GitHub Actions (nunca no repositório). */
function baleias(): Keypair[] {
  mkdirSync(KEYS, { recursive: true });
  return Array.from({ length: MEMBERS }, (_, i) => loadOrCreate(`${KEYS}/baleia-${i + 1}.json`));
}

/** 7 Baleias diferentes a cada rodada, para mostrar que qualquer maioria qualificada valida. */
function pickSigners(all: Keypair[], seed: number): Keypair[] {
  const order = all.map((kp, i) => ({ kp, k: Math.sin(seed * 997 + i * 31) }));
  return order.sort((a, b) => a.k - b.k).slice(0, THRESHOLD).map((o) => o.kp);
}

/**
 * Uma validação completa na multisig, em 3 transações: (1) a proponente cria a transação do cofre e abre a proposta;
 * (2) as 7 Baleias assinam juntas as aprovações; (3) a proposta aprovada é executada pelo cofre.
 */
async function validate(msPda: PublicKey, members: Keypair[], ix: TransactionInstruction, action: string): Promise<Validation> {
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
  const transactionIndex = BigInt(Number(info.transactionIndex) + 1);
  const signers = pickSigners(members, Number(transactionIndex));
  const proposer = signers[0];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const createSignature = await send(
    [
      multisig.instructions.vaultTransactionCreate({
        multisigPda: msPda,
        transactionIndex,
        creator: proposer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [ix] }),
        memo: `cambI: ${action}`.slice(0, 80),
      }),
      multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex, creator: proposer.publicKey }),
    ],
    [proposer],
  );
  const approveSignature = await send(
    signers.map((m) => multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex, member: m.publicKey })),
    signers,
  );
  console.log(`  ✓ ${THRESHOLD} Baleias aprovaram juntas: ${approveSignature}`);
  const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: msPda, transactionIndex, member: proposer.publicKey });
  const executeSignature = await send([instruction], [proposer]);
  console.log(`${action}: executada ${executeSignature}`);
  return {
    index: Number(transactionIndex),
    action,
    at: new Date().toISOString(),
    proposer: proposer.publicKey.toBase58(),
    approvals: signers.map((m) => ({ member: m.publicKey.toBase58(), signature: approveSignature })),
    createSignature,
    executeSignature,
  };
}

async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const pid = program.programId;
  const members = baleias();
  console.log(`Deployer ${admin.publicKey.toBase58()}: ${(await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  let price = 5.0;
  let source = "reserva fixa";
  try {
    const q = await fetchConsensusQuote();
    price = q.price;
    source = q.used.map((x) => `${x.source} ${x.price.toFixed(4)}`).join(", ");
  } catch (e) {
    console.log(`Consenso indisponível, usando ${price}: ${(e as Error).message}`);
  }
  const priceRaw = new anchor.BN(Math.round(price * PRICE_SCALE));

  // ---------------- Rodada de cotação (pool já existe) ----------------
  if (existsSync(FILE)) {
    const dep = JSON.parse(readFileSync(FILE, "utf8"));
    const pool = new PublicKey(dep.pool);
    const msPda = new PublicKey(dep.consortium.multisig);
    const vault = new PublicKey(dep.consortium.vault);
    const before = await (program.account as any).pool.fetch(pool);
    const old = Number(before.price.toString()) / PRICE_SCALE;
    if (Math.abs(price / old - 1) > 0.1) throw new Error(`Variação acima de 10% (${old} → ${price}); cotação não proposta.`);
    // A proponente paga as taxas e as contas da proposta: completa o SOL dela, se precisar.
    const idx = Number((await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed")).transactionIndex) + 1;
    const proposer = pickSigners(members, idx)[0];
    if ((await connection.getBalance(proposer.publicKey)) < 0.03 * LAMPORTS_PER_SOL) {
      await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: proposer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [admin]);
    }
    const ix = await program.methods.setPrice(priceRaw).accountsPartial({ oracle: vault, pool }).instruction();
    const v = await validate(msPda, members, ix, `Cotação R$ ${old.toFixed(4)} → R$ ${price.toFixed(4)} (${source})`);
    dep.consortium.validations = [v, ...dep.consortium.validations].slice(0, 30);
    dep.updatedAt = new Date().toISOString();
    writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
    summary(dep);
    return;
  }

  // ---------------- Montagem do pool do consórcio ----------------
  const txs: { label: string; signature: string }[] = [];
  const log = (label: string, signature: string) => {
    txs.push({ label, signature });
    console.log(`${label}: ${signature}`);
  };

  // SOL para as taxas: a proponente de cada rodada paga as contas da proposta; todas assinam aprovações.
  const consortium = JSON.parse(readFileSync(CONSORTIUM_FILE, "utf8")).consortium;
  if (members.some((m, i) => m.publicKey.toBase58() !== consortium.members[i].key)) throw new Error("Chaves das Baleias não batem com o consórcio");
  log(
    "SOL de taxas para as 10 Baleias",
    await send(
      members.map((m) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: m.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })),
      [admin],
    ),
  );

  // Moedas de teste com emissão já no PDA do pool (faucet on-chain), criadas numa transação só.
  const brlMint = Keypair.generate();
  const usdMint = Keypair.generate();
  const pool = poolPda(pid, brlMint.publicKey, usdMint.publicKey);
  const brlVault = vaultPda(pid, pool, brlMint.publicKey);
  const usdVault = vaultPda(pid, pool, usdMint.publicKey);
  const mintAuthority = mintAuthorityPda(pid, pool);
  const rent = await getMinimumBalanceForRentExemptMint(connection);
  const mintIxs = (m: Keypair) => [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: m.publicKey, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(m.publicKey, DECIMALS, admin.publicKey, null),
    createSetAuthorityInstruction(m.publicKey, admin.publicKey, AuthorityType.MintTokens, mintAuthority),
  ];
  log("Moedas de teste do consórcio (cBRL e cUSD)", await send([...mintIxs(brlMint), ...mintIxs(usdMint)], [admin, brlMint, usdMint]));

  log(
    `Pool v2 criado (R$ ${price.toFixed(4)} por dólar): KYC exigido, disjuntor 30%/h, saque imediato até 10% e fila com 10 min de aviso`,
    await send(
      [
        await program.methods
          .initialize(priceRaw, new anchor.BN(MAX_PRICE_AGE))
          .accountsPartial({
            admin: admin.publicKey,
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
        await program.methods.setLimits(new anchor.BN(MAX_PRICE_AGE), MAX_PRICE_MOVE_BPS, new anchor.BN(LOCKUP_SECS)).accountsPartial({ admin: admin.publicKey, pool }).instruction(),
        await program.methods
          .setSafety(new anchor.BN(SAFETY.window), SAFETY.breakerBps, SAFETY.instantBps, new anchor.BN(SAFETY.notice), SAFETY.limits.map((v) => u(v)))
          .accountsPartial({ admin: admin.publicKey, pool })
          .instruction(),
      ],
      [admin],
    ),
  );

  const mintTo = (side: number, amount: number, destination: PublicKey) =>
    program.methods
      .adminMint(side, u(amount))
      .accountsPartial({ admin: admin.publicKey, pool, mint: side === BRL ? brlMint.publicKey : usdMint.publicKey, destination, mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
  const depositIx = (user: PublicKey, tranche: number, side: number, amount: number, userBrl: PublicKey, userUsd: PublicKey) =>
    program.methods
      .deposit(tranche, side, u(amount))
      .accountsPartial({
        user,
        pool,
        position: positionPda(pid, pool, user, tranche, side),
        brlVault,
        usdVault,
        userBrl,
        userUsd,
        credential: credentialPda(pid, pool, user),
        brlMint: brlMint.publicKey,
        usdMint: usdMint.publicKey,
        brlReserve: null,
        usdReserve: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  // Credencial KYC nível 3 (institucional), emitida pelo deployer no papel do parceiro regulado.
  const credentialIx = (user: PublicKey, level = 3) =>
    program.methods
      .issueCredential(level, new anchor.BN(Math.floor(Date.now() / 1000) + 365 * 86_400))
      .accountsPartial({ issuer: admin.publicKey, pool, user, credential: credentialPda(pid, pool, user), systemProgram: SystemProgram.programId })
      .instruction();
  const atas = (owner: PublicKey) => ({
    brl: getAssociatedTokenAddressSync(brlMint.publicKey, owner),
    usd: getAssociatedTokenAddressSync(usdMint.publicKey, owner),
  });
  const ataIxs = (owner: PublicKey) => [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, atas(owner).brl, owner, brlMint.publicKey),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, atas(owner).usd, owner, usdMint.publicKey),
  ];

  // As 10 Baleias depositam nas duas moedas (portes diferentes), uma transação por Baleia.
  const sizes = [20_000, 15_000, 12_000, 10_000, 10_000, 8_000, 8_000, 6_000, 6_000, 5_000];
  for (const [i, m] of members.entries()) {
    const a = atas(m.publicKey);
    const brl = sizes[i];
    const usd = Math.round(sizes[i] / price);
    log(
      `Baleia ${i + 1} deposita R$ ${brl.toLocaleString("pt-BR")} + US$ ${usd.toLocaleString("pt-BR")}`,
      await send(
        [
          ...ataIxs(m.publicKey),
          await credentialIx(m.publicKey),
          await mintTo(BRL, brl, a.brl),
          await mintTo(USD, usd, a.usd),
          await depositIx(m.publicKey, BALEIA, BRL, brl, a.brl, a.usd),
          await depositIx(m.publicKey, BALEIA, USD, usd, a.brl, a.usd),
        ],
        [admin, m],
      ),
    );
  }

  // Um depositante da Rende (faixa sênior), também numa transação só.
  const rende = Keypair.generate();
  const ra = atas(rende.publicKey);
  log(
    "Depósito Rende: R$ 50.000 (credencial nível 2)",
    await send(
      [
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: rende.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
        ...ataIxs(rende.publicKey),
        await credentialIx(rende.publicKey, 2),
        await mintTo(BRL, 50_000, ra.brl),
        await depositIx(rende.publicKey, RENDE, BRL, 50_000, ra.brl, ra.usd),
      ],
      [admin, rende],
    ),
  );

  // Governança: a MESMA multisig 7 de 10 do consórcio.
  const msPda = new PublicKey(consortium.multisig);
  const vault = new PublicKey(consortium.vault);
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  const { Permissions } = multisig.types;
  log(
    "Oráculo do pool passa para o cofre da multisig, admin proposto para ela e guardião de plantão definido",
    await send(
      [
        await program.methods.setOracle(vault).accountsPartial({ admin: admin.publicKey, pool }).instruction(),
        await program.methods.proposeAdmin(vault).accountsPartial({ admin: admin.publicKey, pool }).instruction(),
        // Guardião de plantão: só consegue pausar.
        await program.methods.setGuardian(admin.publicKey).accountsPartial({ admin: admin.publicKey, pool }).instruction(),
      ],
      [admin],
    ),
  );

  const validations: Validation[] = [];
  validations.unshift(await validate(msPda, members, await program.methods.acceptAdmin().accountsPartial({ newAdmin: vault, pool }).instruction(), "Multisig assume o admin do pool"));
  validations.unshift(
    await validate(msPda, members, await program.methods.setPrice(priceRaw).accountsPartial({ oracle: vault, pool }).instruction(), `Primeira cotação validada: R$ ${price.toFixed(4)} (${source})`),
  );

  const after = await (program.account as any).pool.fetch(pool);
  if (!after.admin.equals(vault) || !after.oracle.equals(vault)) throw new Error("Admin/oráculo do pool não ficaram no cofre da multisig");

  // Multisig de UPGRADE: as mesmas Baleias, 7 de 10, com prazo de espera entre aprovar e executar.
  // Separada da de governança para o prazo não atrasar as cotações.
  const upgradeKey = Keypair.generate();
  const [upgradeMs] = multisig.getMultisigPda({ createKey: upgradeKey.publicKey });
  const [upgradeVault] = multisig.getVaultPda({ multisigPda: upgradeMs, index: 0 });
  log(
    `Multisig de upgrade criada (${THRESHOLD} de ${MEMBERS}, espera de ${UPGRADE_TIMELOCK_SECS / 3600} h)`,
    await send(
      [
        multisig.instructions.multisigCreateV2({
          treasury: programConfig.treasury,
          creator: admin.publicKey,
          multisigPda: upgradeMs,
          configAuthority: null,
          threshold: THRESHOLD,
          members: members.map((m) => ({ key: m.publicKey, permissions: Permissions.all() })),
          timeLock: UPGRADE_TIMELOCK_SECS,
          createKey: upgradeKey.publicKey,
          rentCollector: null,
        }),
      ],
      [admin, upgradeKey],
    ),
  );
  // Autoridade de upgrade do programa v2 sai da chave do deployer e vai para o cofre da multisig de upgrade.
  // (Feito por último: criar pools exige a autoridade de upgrade.)
  log(
    "Autoridade de upgrade do programa v2 passa para a multisig de upgrade",
    await send(
      [
        new TransactionInstruction({
          programId: BPF_LOADER_UPGRADEABLE,
          keys: [
            { pubkey: programDataPda(pid), isSigner: false, isWritable: true },
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: upgradeVault, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([4, 0, 0, 0]), // SetAuthority
        }),
      ],
      [admin],
    ),
  );
  const pd = await connection.getAccountInfo(programDataPda(pid), "confirmed");
  // ProgramData: 4 (tipo) + 8 (slot) + 1 (Option) + 32 (autoridade)
  if (!pd || pd.data[12] !== 1 || !new PublicKey(pd.data.subarray(13, 45)).equals(upgradeVault)) throw new Error("Autoridade de upgrade não ficou na multisig");

  const dep = {
    cluster: "devnet",
    version: 2,
    kind: "consortium-v2",
    rpc: RPC,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    programId: pid.toBase58(),
    pool: pool.toBase58(),
    brlMint: brlMint.publicKey.toBase58(),
    usdMint: usdMint.publicKey.toBase58(),
    brlVault: brlVault.toBase58(),
    usdVault: usdVault.toBase58(),
    mintAuthority: mintAuthority.toBase58(),
    admin: vault.toBase58(),
    oracle: vault.toBase58(),
    payout: admin.publicKey.toBase58(),
    consortium: {
      squadsProgram: multisig.PROGRAM_ID.toBase58(),
      multisig: msPda.toBase58(),
      vault: vault.toBase58(),
      threshold: THRESHOLD,
      members: members.map((m, i) => ({ name: `Baleia ${i + 1}`, key: m.publicKey.toBase58(), depositBRL: sizes[i], depositUSD: Math.round(sizes[i] / price) })),
      upgradeAuthorityInMultisig: true,
      upgrade: { multisig: upgradeMs.toBase58(), vault: upgradeVault.toBase58(), threshold: THRESHOLD, timeLockSecs: UPGRADE_TIMELOCK_SECS },
      validations,
    },
    security: {
      kycIssuer: admin.publicKey.toBase58(),
      kycIssuerNote: "Na devnet o deployer simula o parceiro regulado que faz o KYC.",
      guardian: admin.publicKey.toBase58(),
      levelLimitsBRL: SAFETY.limits,
      breaker: { windowSecs: SAFETY.window, bps: SAFETY.breakerBps },
      instantWithdrawBps: SAFETY.instantBps,
      withdrawNoticeSecs: SAFETY.notice,
      reserveProof: "desligada na devnet (moedas de teste sem custodiante); ligada com set_reserve_policy quando houver lastro real",
    },
    transactions: txs.map((t) => ({ ...t, url: explorer("tx", t.signature) })),
    links: { program: explorer("address", pid.toBase58()), pool: explorer("address", pool.toBase58()), multisig: explorer("address", msPda.toBase58()) },
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
  summary(dep);
}

function summary(dep: any) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  const rows = dep.consortium.validations
    .map((v: Validation) => `| #${v.index} | ${v.action} | ${v.approvals.length} de ${dep.consortium.members.length} | [executada](${explorer("tx", v.executeSignature)}) |`)
    .join("\n");
  const text = `## Programa v2 + consórcio (devnet)\n\n- Pool: [${dep.pool}](${dep.links.pool})\n- Multisig (${dep.consortium.threshold} de ${dep.consortium.members.length}): [${dep.consortium.multisig}](${dep.links.multisig})\n\n| Proposta | Ação | Assinaturas | Prova |\n|---|---|---|---|\n${rows}\n`;
  console.log(text);
  if (out) appendFileSync(out, text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
