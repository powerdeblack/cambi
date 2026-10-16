// Pool do consórcio (branch v2): um SEGUNDO pool na devnet, com moedas de teste próprias, governado por uma multisig
// Squads de 10 Baleias (7 de 10). O pool avaliado (deployments/devnet.json) não é tocado.
//
// Primeira execução (sem deployments/devnet-consortium.json):
//   - cria moedas de teste, o pool, os limites e o faucet;
//   - 10 Baleias (chaves em .consortium-keys) depositam real e dólar na faixa Baleia;
//   - cria a multisig 7 de 10 e passa para o cofre dela o ORÁCULO e o ADMIN do pool;
//   - a própria multisig valida a troca de admin e a primeira cotação (propostas com 7 assinaturas).
// Execuções seguintes: uma rodada de cotação validada pela multisig (proposta, 7 aprovações, execução).
//
// Uso (GitHub Actions): ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.devnet-keys/deployer.json npx tsx scripts/consortium.ts
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { AuthorityType, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, setAuthority } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fetchConsensusQuote } from "../app/src/quote";
import idl from "../idl/cambi_pool.json";
import { BALEIA, BRL, RENDE, USD, createMints, mintAuthorityPda, politeConnection, poolPda, positionPda, programDataPda, u, vaultPda } from "./common";

const FILE = "deployments/devnet-consortium.json";
const KEYS = ".consortium-keys";
const MEMBERS = 10;
const THRESHOLD = 7;
const MAX_PRICE_AGE = 86_400; // sem cron neste branch: a cotação vale 24 h (limite do programa)
const MAX_PRICE_MOVE_BPS = 1_000;
const LOCKUP_SECS = 600;
const PRICE_SCALE = 1_000_000;
const CONFIRMED = { commitment: "confirmed" as const };
const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

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

/** Uma validação completa na multisig: cria a transação do cofre, abre a proposta, 7 Baleias aprovam, executa. */
async function validate(
  connection: anchor.web3.Connection,
  msPda: PublicKey,
  members: Keypair[],
  ix: TransactionInstruction,
  action: string,
): Promise<Validation> {
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed");
  const transactionIndex = BigInt(Number(info.transactionIndex) + 1);
  const signers = pickSigners(members, Number(transactionIndex));
  const proposer = signers[0];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const send = { skipPreflight: false, preflightCommitment: "confirmed" as const };
  const wait = (sig: string) => connection.confirmTransaction(sig, "confirmed").then(() => sig);

  const createSignature = await wait(
    await multisig.rpc.vaultTransactionCreate({
      connection,
      feePayer: proposer,
      multisigPda: msPda,
      transactionIndex,
      creator: proposer.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [ix] }),
      memo: `cambI: ${action}`.slice(0, 80),
      sendOptions: send,
    }),
  );
  await wait(await multisig.rpc.proposalCreate({ connection, feePayer: proposer, creator: proposer, multisigPda: msPda, transactionIndex, sendOptions: send }));
  const approvals: Validation["approvals"] = [];
  for (const m of signers) {
    const signature = await wait(await multisig.rpc.proposalApprove({ connection, feePayer: proposer, member: m, multisigPda: msPda, transactionIndex, sendOptions: send }));
    approvals.push({ member: m.publicKey.toBase58(), signature });
    console.log(`  ✓ Baleia ${m.publicKey.toBase58().slice(0, 6)} aprovou (${approvals.length}/${THRESHOLD})`);
  }
  const executeSignature = await wait(
    await multisig.rpc.vaultTransactionExecute({ connection, feePayer: proposer, multisigPda: msPda, transactionIndex, member: proposer.publicKey, sendOptions: send }),
  );
  console.log(`${action}: executada ${executeSignature}`);
  return {
    index: Number(transactionIndex),
    action,
    at: new Date().toISOString(),
    proposer: proposer.publicKey.toBase58(),
    approvals,
    createSignature,
    executeSignature,
  };
}

async function main() {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(politeConnection(env.connection.rpcEndpoint), env.wallet, CONFIRMED);
  anchor.setProvider(provider);
  const program = new Program(idl as Idl, provider);
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;
  const members = baleias();

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
    // O proponente paga as taxas da rodada: completa o SOL dele com o do deployer, se precisar.
    const proposer = pickSigners(members, Number((await multisig.accounts.Multisig.fromAccountAddress(connection, msPda, "confirmed")).transactionIndex) + 1)[0];
    if ((await connection.getBalance(proposer.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
      await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: proposer.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    }
    const ix = await program.methods.setPrice(priceRaw).accountsPartial({ oracle: vault, pool }).instruction();
    const v = await validate(connection, msPda, members, ix, `Cotação R$ ${old.toFixed(4)} → R$ ${price.toFixed(4)} (${source})`);
    dep.consortium.validations = [v, ...dep.consortium.validations].slice(0, 30);
    dep.updatedAt = new Date().toISOString();
    writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
    writeFileSync("app/src/devnet.json", JSON.stringify(dep, null, 2) + "\n");
    summary(dep);
    return;
  }

  // ---------------- Montagem do pool do consórcio ----------------
  const txs: { label: string; signature: string }[] = [];
  const log = (label: string, signature: string) => {
    txs.push({ label, signature });
    console.log(`${label}: ${signature}`);
  };

  // SOL para as taxas: cada Baleia assina a aprovação; a proponente paga as contas da proposta.
  const fund = new Transaction();
  members.forEach((m, i) =>
    fund.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: m.publicKey, lamports: (i === 0 ? 0.04 : 0.025) * LAMPORTS_PER_SOL })),
  );
  await provider.sendAndConfirm(fund);

  const mints = await createMints(connection, admin);
  const pool = poolPda(pid, mints.brl, mints.usd);
  const brlVault = vaultPda(pid, pool, mints.brl);
  const usdVault = vaultPda(pid, pool, mints.usd);
  const mintAuthority = mintAuthorityPda(pid, pool);
  log(
    `Pool do consórcio criado (R$ ${price.toFixed(4)} por dólar)`,
    await program.methods
      .initialize(priceRaw, new anchor.BN(MAX_PRICE_AGE))
      .accountsPartial({
        admin: admin.publicKey,
        brlMint: mints.brl,
        usdMint: mints.usd,
        pool,
        brlVault,
        usdVault,
        program: pid,
        programData: programDataPda(pid),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );
  log(
    "Limites: cotação vale 24 h, move até 10% por vez, depósito travado 10 min",
    await program.methods
      .setLimits(new anchor.BN(MAX_PRICE_AGE), MAX_PRICE_MOVE_BPS, new anchor.BN(LOCKUP_SECS))
      .accountsPartial({ admin: admin.publicKey, pool })
      .rpc(),
  );
  await setAuthority(connection, admin, mints.brl, admin, AuthorityType.MintTokens, mintAuthority, [], CONFIRMED);
  await setAuthority(connection, admin, mints.usd, admin, AuthorityType.MintTokens, mintAuthority, [], CONFIRMED);

  const adminMint = (side: number, amount: number, destination: PublicKey) =>
    program.methods
      .adminMint(side, u(amount))
      .accountsPartial({ admin: admin.publicKey, pool, mint: side === BRL ? mints.brl : mints.usd, destination, mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();

  // As 10 Baleias depositam nas duas moedas (valores diferentes, como empresas de portes diferentes).
  const sizes = [20_000, 15_000, 12_000, 10_000, 10_000, 8_000, 8_000, 6_000, 6_000, 5_000];
  for (const [i, m] of members.entries()) {
    const brlAta = await createAssociatedTokenAccountIdempotent(connection, admin, mints.brl, m.publicKey, CONFIRMED);
    const usdAta = await createAssociatedTokenAccountIdempotent(connection, admin, mints.usd, m.publicKey, CONFIRMED);
    const brl = sizes[i];
    const usd = Math.round(sizes[i] / price);
    await adminMint(BRL, brl, brlAta);
    await adminMint(USD, usd, usdAta);
    for (const [side, amount] of [
      [BRL, brl],
      [USD, usd],
    ] as const) {
      log(
        `Baleia ${i + 1} deposita ${side === BRL ? `R$ ${brl.toLocaleString("pt-BR")}` : `US$ ${usd.toLocaleString("pt-BR")}`}`,
        await program.methods
          .deposit(BALEIA, side, u(amount))
          .accountsPartial({
            user: m.publicKey,
            pool,
            position: positionPda(pid, pool, m.publicKey, BALEIA, side),
            brlVault,
            usdVault,
            userBrl: brlAta,
            userUsd: usdAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([m])
          .rpc(),
      );
    }
  }

  // Um depositante da Rende, para o pool ter a faixa sênior também.
  const rende = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: rende.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })));
  const rBrl = await createAssociatedTokenAccountIdempotent(connection, admin, mints.brl, rende.publicKey, CONFIRMED);
  const rUsd = await createAssociatedTokenAccountIdempotent(connection, admin, mints.usd, rende.publicKey, CONFIRMED);
  await adminMint(BRL, 50_000, rBrl);
  log(
    "Depósito Rende: R$ 50.000",
    await program.methods
      .deposit(RENDE, BRL, u(50_000))
      .accountsPartial({
        user: rende.publicKey,
        pool,
        position: positionPda(pid, pool, rende.publicKey, RENDE, BRL),
        brlVault,
        usdVault,
        userBrl: rBrl,
        userUsd: rUsd,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([rende])
      .rpc(),
  );

  // Multisig 7 de 10 (Squads v4), sem autoridade de configuração: só as próprias Baleias mudam a multisig.
  const createKey = Keypair.generate();
  const [msPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  const { Permissions } = multisig.types;
  const createSig = await multisig.rpc.multisigCreateV2({
    connection,
    treasury: programConfig.treasury,
    createKey,
    creator: admin,
    multisigPda: msPda,
    configAuthority: null,
    threshold: THRESHOLD,
    members: members.map((m) => ({ key: m.publicKey, permissions: Permissions.all() })),
    timeLock: 0,
    rentCollector: null,
    sendOptions: { preflightCommitment: "confirmed" },
  });
  await connection.confirmTransaction(createSig, "confirmed");
  log(`Multisig das Baleias criada (${THRESHOLD} de ${MEMBERS})`, createSig);

  log("Oráculo do pool passa para o cofre da multisig", await program.methods.setOracle(vault).accountsPartial({ admin: admin.publicKey, pool }).rpc());
  log("Admin do pool proposto para o cofre da multisig", await program.methods.proposeAdmin(vault).accountsPartial({ admin: admin.publicKey, pool }).rpc());

  const validations: Validation[] = [];
  validations.unshift(
    await validate(connection, msPda, members, await program.methods.acceptAdmin().accountsPartial({ newAdmin: vault, pool }).instruction(), "Multisig assume o admin do pool"),
  );
  validations.unshift(
    await validate(
      connection,
      msPda,
      members,
      await program.methods.setPrice(priceRaw).accountsPartial({ oracle: vault, pool }).instruction(),
      `Primeira cotação validada: R$ ${price.toFixed(4)} (${source})`,
    ),
  );

  const after = await (program.account as any).pool.fetch(pool);
  if (!after.admin.equals(vault) || !after.oracle.equals(vault)) throw new Error("Admin/oráculo do pool não ficaram no cofre da multisig");

  const dep = {
    cluster: "devnet",
    version: 2,
    kind: "consortium",
    rpc: "https://api.devnet.solana.com",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    programId: pid.toBase58(),
    pool: pool.toBase58(),
    brlMint: mints.brl.toBase58(),
    usdMint: mints.usd.toBase58(),
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
      // Limitação conhecida: este pool usa o mesmo programa do pool avaliado; a autoridade de upgrade do programa
      // continua numa chave só. Num produto real ela também iria para a multisig, com timelock.
      upgradeAuthorityInMultisig: false,
      validations,
    },
    transactions: txs.map((t) => ({ ...t, url: explorer("tx", t.signature) })),
    links: { program: explorer("address", pid.toBase58()), pool: explorer("address", pool.toBase58()), multisig: explorer("address", msPda.toBase58()) },
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
  writeFileSync("app/src/devnet.json", JSON.stringify(dep, null, 2) + "\n");
  summary(dep);
}

function summary(dep: any) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  const rows = dep.consortium.validations
    .map((v: Validation) => `| #${v.index} | ${v.action} | ${v.approvals.length}/${dep.consortium.members.length} | [executada](${explorer("tx", v.executeSignature)}) |`)
    .join("\n");
  const text = `## Consórcio de Baleias (devnet)\n\n- Pool: [${dep.pool}](${dep.links.pool})\n- Multisig (${dep.consortium.threshold} de ${dep.consortium.members.length}): [${dep.consortium.multisig}](${dep.links.multisig})\n\n| Proposta | Ação | Assinaturas | Prova |\n|---|---|---|---|\n${rows}\n`;
  console.log(text);
  if (out) appendFileSync(out, text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
