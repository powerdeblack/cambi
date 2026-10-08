// Testes de integração: rodam o programa numa Solana local (`anchor test`), compilado com a feature `devnet`.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AuthorityType, TOKEN_PROGRAM_ID, setAuthority } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { CambiPool } from "../target/types/cambi_pool";
import {
  BALEIA,
  BRL,
  Mints,
  RENDE,
  USD,
  User,
  claimPda,
  createMints,
  mintAuthorityPda,
  partnerPda,
  poolPda,
  positionPda,
  programDataPda,
  setupUser,
  tokenBalance,
  u,
  vaultPda,
} from "../scripts/common";

const PRICE = 5.4;
const PRICE_RAW = new anchor.BN(5_400_000);
const CONFIRMED = { commitment: "confirmed" as const };

async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    const got = [e?.error?.errorCode?.code, e?.message, ...(e?.logs ?? []), String(e)].join(" | ");
    expect(got).to.contain(code);
    return;
  }
  expect.fail(`esperava o erro ${code}`);
}

describe("cambi_pool", () => {
  // Tudo em "confirmed": a leitura de saldos logo após cada transação precisa enxergar o resultado dela.
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(env.connection, env.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const program = anchor.workspace.CambiPool as Program<CambiPool>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;
  const programData = programDataPda(pid);

  let mints: Mints;
  let pool: PublicKey;
  let brlVault: PublicKey;
  let usdVault: PublicKey;
  let alice: User; // Rende em reais
  let bob: User; // Rende em dólar
  let whale: User; // Baleia nas duas moedas
  let carol: User; // varejo
  let app: User; // app parceiro (B2B)

  interface Ctx {
    pool: PublicKey;
    brlVault: PublicKey;
    usdVault: PublicKey;
  }
  const main = (): Ctx => ({ pool, brlVault, usdVault });

  const initialize = (m: Mints, maxAge = 3600, signer: Keypair = admin) => {
    const p = poolPda(pid, m.brl, m.usd);
    return program.methods
      .initialize(PRICE_RAW, new anchor.BN(maxAge))
      .accountsPartial({
        admin: signer.publicKey,
        brlMint: m.brl,
        usdMint: m.usd,
        pool: p,
        brlVault: vaultPda(pid, p, m.brl),
        usdVault: vaultPda(pid, p, m.usd),
        program: pid,
        programData,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(signer === admin ? [] : [signer])
      .rpc();
  };

  const setLimits = (c: Ctx, maxAge: number, moveBps: number, lockup: number) =>
    program.methods
      .setLimits(new anchor.BN(maxAge), moveBps, new anchor.BN(lockup))
      .accountsPartial({ admin: admin.publicKey, pool: c.pool })
      .rpc();

  const deposit = (user: User, tranche: number, side: number, amount: number, c: Ctx = main()) =>
    program.methods
      .deposit(tranche, side, u(amount))
      .accountsPartial({
        user: user.kp.publicKey,
        pool: c.pool,
        position: positionPda(pid, c.pool, user.kp.publicKey, tranche, side),
        brlVault: c.brlVault,
        usdVault: c.usdVault,
        userBrl: user.brl,
        userUsd: user.usd,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user.kp])
      .rpc();

  const withdraw = (user: User, tranche: number, side: number, amount: number, c: Ctx = main()) =>
    program.methods
      .withdraw(u(amount))
      .accountsPartial({
        user: user.kp.publicKey,
        pool: c.pool,
        position: positionPda(pid, c.pool, user.kp.publicKey, tranche, side),
        brlVault: c.brlVault,
        usdVault: c.usdVault,
        userBrl: user.brl,
        userUsd: user.usd,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.kp])
      .rpc();

  const swap = (
    user: User,
    side: number,
    amount: number,
    opts: { position?: PublicKey; partner?: PublicKey; minOut?: number; ctx?: Ctx } = {},
  ) => {
    const c = opts.ctx ?? main();
    return program.methods
      .swap(side, u(amount), u(opts.minOut ?? 0))
      .accountsPartial({
        user: user.kp.publicKey,
        pool: c.pool,
        brlVault: c.brlVault,
        usdVault: c.usdVault,
        userBrl: user.brl,
        userUsd: user.usd,
        depositorPosition: opts.position ?? null,
        partner: opts.partner ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.kp])
      .rpc();
  };

  /** Taxa efetiva paga numa troca de reais por dólar, medida pelos saldos. */
  async function feeRateBrlToUsd(user: User, amount: number, opts: Parameters<typeof swap>[3] = {}) {
    const before = await tokenBalance(connection, user.usd);
    await swap(user, BRL, amount, opts);
    const received = (await tokenBalance(connection, user.usd)) - before;
    return 1 - (received * PRICE) / amount;
  }

  /** Pool novo e isolado, para cenários de ataque. */
  async function freshPool(maxAge = 3600) {
    const m = await createMints(connection, admin);
    await initialize(m, maxAge);
    const p = poolPda(pid, m.brl, m.usd);
    return { m, ctx: { pool: p, brlVault: vaultPda(pid, p, m.brl), usdVault: vaultPda(pid, p, m.usd) } };
  }

  before(async () => {
    mints = await createMints(connection, admin);
    pool = poolPda(pid, mints.brl, mints.usd);
    brlVault = vaultPda(pid, pool, mints.brl);
    usdVault = vaultPda(pid, pool, mints.usd);
    alice = await setupUser(connection, admin, mints, { brl: 200_000, usd: 0 }, { airdropSol: 2 });
    bob = await setupUser(connection, admin, mints, { brl: 0, usd: 30_000 }, { airdropSol: 2 });
    whale = await setupUser(connection, admin, mints, { brl: 50_000, usd: 10_000 }, { airdropSol: 2 });
    carol = await setupUser(connection, admin, mints, { brl: 50_000, usd: 10_000 }, { airdropSol: 2 });
    app = await setupUser(connection, admin, mints, { brl: 0, usd: 5_000 }, { airdropSol: 2 });
  });

  it("só a autoridade de upgrade do programa cria pools", async () => {
    const intruso = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(intruso.publicKey, 1e9), "confirmed");
    const m = await createMints(connection, admin);
    await expectError(initialize(m, 3600, intruso), "Unauthorized");
  });

  it("inicializa o pool com cofres, configuração padrão e travas de segurança", async () => {
    await initialize(mints);
    const p = await program.account.pool.fetch(pool);
    expect(p.price.toString()).to.equal(PRICE_RAW.toString());
    expect(p.brlVault.toBase58()).to.equal(brlVault.toBase58());
    expect(p.fees.retailBps).to.equal(100);
    expect(p.paused).to.equal(false);
    expect(p.lockupSecs.toNumber()).to.equal(600);
    expect(p.maxPriceMoveBps).to.equal(1_000);
  });

  it("recusa depósito abaixo de R$ 10", async () => {
    await expectError(deposit(carol, RENDE, BRL, 5), "DepositTooSmall");
  });

  it("registra depósitos com shares pelo valor em reais", async () => {
    await deposit(alice, RENDE, BRL, 100_000);
    await deposit(bob, RENDE, USD, 20_000);
    await deposit(whale, BALEIA, BRL, 20_000);
    await deposit(whale, BALEIA, USD, 4_000);
    const p = await program.account.pool.fetch(pool);
    expect(p.principal.map((v) => v.toString())).to.deep.equal([
      u(100_000).toString(),
      u(20_000).toString(),
      u(20_000).toString(),
      u(4_000).toString(),
    ]);
    // Rende: 100.000 reais + 20.000 dólares * 5,40 = 208.000 reais em shares
    expect(p.shares[RENDE].toString()).to.equal(u(208_000).toString());
    expect(p.shares[BALEIA].toString()).to.equal(u(20_000 + 4_000 * PRICE).toString());
  });

  it("trava o resgate do principal logo após o depósito (contra liquidez relâmpago)", async () => {
    await expectError(withdraw(alice, RENDE, BRL, 1_000), "PositionLocked");
    // Colher taxas (saque zero) continua liberado.
    await withdraw(alice, RENDE, BRL, 0);
    // Para os próximos testes, a trava vai a zero (o admin ajusta dentro de limites).
    await setLimits(main(), 3600, 1_000, 0);
  });

  it("cobra a taxa de varejo e reserva as taxas fora da liquidez", async () => {
    const rate = await feeRateBrlToUsd(carol, 1_000);
    // Pool com um pouco mais de dólar: entrar com real ajuda o equilíbrio, então a taxa fica entre 0,7% e 1%.
    expect(rate).to.be.greaterThan(0.0069).and.lessThan(0.0101);
    const p = await program.account.pool.fetch(pool);
    expect(p.lpFeesUnclaimed[BRL].toNumber()).to.be.greaterThan(0);
    expect(p.platformFees[BRL].toNumber()).to.be.greaterThan(0);
    expect(p.partnerFees[BRL].toNumber()).to.be.greaterThan(0);
    expect(p.swapCount.toNumber()).to.equal(1);
  });

  it("dá metade da taxa para quem é depositante", async () => {
    const retail = await feeRateBrlToUsd(carol, 1_000);
    const depositor = await feeRateBrlToUsd(alice, 1_000, { position: positionPda(pid, pool, alice.kp.publicKey, RENDE, BRL) });
    expect(depositor).to.be.lessThan(retail * 0.6);
  });

  it("não aceita a posição de outra pessoa como desconto", async () => {
    await expectError(swap(carol, BRL, 100, { position: positionPda(pid, pool, alice.kp.publicKey, RENDE, BRL) }), "InvalidPosition");
  });

  it("aplica a taxa B2B para apps parceiros registrados", async () => {
    const partner = partnerPda(pid, pool, app.kp.publicKey);
    await program.methods
      .addPartner()
      .accountsPartial({ admin: admin.publicKey, pool, partnerAuthority: app.kp.publicKey, partner, systemProgram: SystemProgram.programId })
      .rpc();
    const before = await tokenBalance(connection, app.brl);
    await swap(app, USD, 100, { partner });
    const received = (await tokenBalance(connection, app.brl)) - before;
    const rate = 1 - received / (100 * PRICE);
    expect(rate).to.be.lessThan(0.0061); // 0,4% base, no máximo 1,5x
  });

  it("depositante em dólar recebe taxas pagas em reais (divisão por valor)", async () => {
    const brlBefore = await tokenBalance(connection, bob.brl);
    await withdraw(bob, RENDE, USD, 0); // saque zero = só colher as taxas
    const brlAfter = await tokenBalance(connection, bob.brl);
    expect(brlAfter).to.be.greaterThan(brlBefore);
  });

  it("devolve principal e taxas no saque da Rende", async () => {
    const before = await tokenBalance(connection, alice.brl);
    await withdraw(alice, RENDE, BRL, 10_000);
    const after = await tokenBalance(connection, alice.brl);
    expect(after - before).to.be.greaterThan(10_000);
    const pos = await program.account.position.fetch(positionPda(pid, pool, alice.kp.publicKey, RENDE, BRL));
    expect(pos.amount.toString()).to.equal(u(90_000).toString());
  });

  it("recusa troca acima do limite de 20% da liquidez", async () => {
    await expectError(swap(carol, BRL, 40_000), "TradeTooLarge");
  });

  it("respeita o mínimo aceito (proteção de slippage)", async () => {
    await expectError(swap(carol, BRL, 100, { minOut: 1_000 }), "SlippageExceeded");
  });

  it("mantém a Rende sênior: a Baleia não saca se deixar a Rende descoberta", async () => {
    // Tira ~R$ 13.500 do cofre: sobra liquidez acima dos R$ 90.000 de principal da Rende,
    // mas não o suficiente para a Baleia sacar R$ 20.000.
    await swap(carol, USD, 2_500);
    await expectError(withdraw(whale, BALEIA, BRL, 20_000), "BaleiaJuniorLiquidity");
    // Um saque pequeno, que mantém a Rende coberta nas duas moedas, passa.
    await withdraw(whale, BALEIA, BRL, 100);
  });

  it("ataque da auditoria (H-1): a Baleia não sai por uma moeda deixando a Rende descoberta na outra", async () => {
    const { m, ctx } = await freshPool();
    await setLimits(ctx, 3600, 1_000, 0);
    const rende = await setupUser(connection, admin, m, { brl: 0, usd: 1_000 }, { airdropSol: 1 });
    const baleia = await setupUser(connection, admin, m, { brl: 5_000, usd: 0 }, { airdropSol: 1 });
    const trader = await setupUser(connection, admin, m, { brl: 10_000, usd: 0 }, { airdropSol: 1 });
    await deposit(rende, RENDE, USD, 1_000, ctx); // Rende em dólar: US$ 1.000
    await deposit(baleia, BALEIA, BRL, 5_000, ctx); // Baleia em reais
    // Antes de qualquer troca, as duas moedas cobrem a Rende: saque pequeno da Baleia passa.
    await withdraw(baleia, BALEIA, BRL, 50, ctx);
    // Trocas tiram dólar do cofre: agora o cofre de dólar não cobre mais os US$ 1.000 da Rende.
    await swap(trader, BRL, 900, { ctx });
    await expectError(withdraw(baleia, BALEIA, BRL, 100, ctx), "BaleiaJuniorLiquidity");
    // A Rende continua podendo sair com o que há.
    await withdraw(rende, RENDE, USD, 500, ctx);
  });

  it("limita a saída acumulada por minuto (várias trocas não drenam o cofre)", async () => {
    const { m, ctx } = await freshPool();
    const lp = await setupUser(connection, admin, m, { brl: 0, usd: 1_000 }, { airdropSol: 1 });
    const trader = await setupUser(connection, admin, m, { brl: 10_000, usd: 0 }, { airdropSol: 1 });
    await deposit(lp, BALEIA, USD, 1_000, ctx);
    await swap(trader, BRL, 1_000, { ctx }); // ~US$ 183 de saída, dentro dos 20% (US$ 200)
    await expectError(swap(trader, BRL, 200, { ctx }), "OutflowLimit");
  });

  it("pausa trocas e depósitos, mas mantém saques liberados", async () => {
    await program.methods.setPaused(true).accountsPartial({ admin: admin.publicKey, pool }).rpc();
    await expectError(swap(carol, BRL, 100), "Paused");
    await expectError(deposit(carol, RENDE, BRL, 100), "Paused");
    await withdraw(alice, RENDE, BRL, 1);
    await program.methods.setPaused(false).accountsPartial({ admin: admin.publicKey, pool }).rpc();
    await swap(carol, BRL, 100);
  });

  it("só o oráculo atualiza o preço, e dentro do limite de variação", async () => {
    await expectError(
      program.methods.setPrice(new anchor.BN(5_500_000)).accountsPartial({ oracle: carol.kp.publicKey, pool }).signers([carol.kp]).rpc(),
      "ConstraintHasOne",
    );
    await expectError(
      program.methods.setPrice(new anchor.BN(7_000_000)).accountsPartial({ oracle: admin.publicKey, pool }).rpc(),
      "PriceMoveTooLarge",
    );
    await program.methods.setPrice(new anchor.BN(5_500_000)).accountsPartial({ oracle: admin.publicKey, pool }).rpc();
    const p = await program.account.pool.fetch(pool);
    expect(p.price.toNumber()).to.equal(5_500_000);
    await expectError(
      program.methods.updateFees({ ...p.fees, retailBps: 600 }).accountsPartial({ admin: admin.publicKey, pool }).rpc(),
      "InvalidConfig",
    );
    await expectError(setLimits(main(), 0, 1_000, 0), "InvalidConfig");
  });

  it("troca de admin só em dois passos (propor e aceitar)", async () => {
    await program.methods.proposeAdmin(carol.kp.publicKey).accountsPartial({ admin: admin.publicKey, pool }).rpc();
    await expectError(
      program.methods.acceptAdmin().accountsPartial({ newAdmin: bob.kp.publicKey, pool }).signers([bob.kp]).rpc(),
      "NotPendingAdmin",
    );
    await program.methods.acceptAdmin().accountsPartial({ newAdmin: carol.kp.publicKey, pool }).signers([carol.kp]).rpc();
    expect((await program.account.pool.fetch(pool)).admin.toBase58()).to.equal(carol.kp.publicKey.toBase58());
    // Devolve para o admin original.
    await program.methods.proposeAdmin(admin.publicKey).accountsPartial({ admin: carol.kp.publicKey, pool }).signers([carol.kp]).rpc();
    await program.methods.acceptAdmin().accountsPartial({ newAdmin: admin.publicKey, pool }).rpc();
  });

  it("faucet de devnet: regras on-chain (intervalo, saldo baixo, só o admin repõe liquidez)", async () => {
    const { m, ctx } = await freshPool();
    const auth = mintAuthorityPda(pid, ctx.pool);
    await setAuthority(connection, admin, m.brl, admin, AuthorityType.MintTokens, auth, [], CONFIRMED);
    await setAuthority(connection, admin, m.usd, admin, AuthorityType.MintTokens, auth, [], CONFIRMED);
    const dan = await setupUser(connection, admin, m, { brl: 0, usd: 0 }, { airdropSol: 1 });
    const claim = () =>
      program.methods
        .faucetClaim()
        .accountsPartial({
          user: dan.kp.publicKey,
          pool: ctx.pool,
          claim: claimPda(pid, ctx.pool, dan.kp.publicKey),
          brlMint: m.brl,
          userBrl: dan.brl,
          mintAuthority: auth,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([dan.kp])
        .rpc();
    await claim();
    expect(await tokenBalance(connection, dan.brl)).to.equal(1_000);
    await expectError(claim(), "FaucetCooldown");

    const adminMint = (signer: Keypair) =>
      program.methods
        .adminMint(USD, u(500))
        .accountsPartial({ admin: signer.publicKey, pool: ctx.pool, mint: m.usd, destination: dan.usd, mintAuthority: auth, tokenProgram: TOKEN_PROGRAM_ID })
        .signers(signer === admin ? [] : [signer])
        .rpc();
    await expectError(adminMint(dan.kp), "ConstraintHasOne");
    await adminMint(admin);
    expect(await tokenBalance(connection, dan.usd)).to.equal(500);
  });

  it("recusa trocas e depósitos com cotação desatualizada", async () => {
    const { m, ctx } = await freshPool(1);
    const dave = await setupUser(connection, admin, m, { brl: 1_000, usd: 0 }, { kp: Keypair.generate(), airdropSol: 1 });
    await new Promise((r) => setTimeout(r, 3_000));
    await expectError(swap(dave, BRL, 100, { ctx }), "StalePrice");
    await expectError(deposit(dave, RENDE, BRL, 100, ctx), "StalePrice");
  });
});
