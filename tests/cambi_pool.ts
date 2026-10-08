// Testes de integração: rodam o programa numa Solana local (`anchor test`).
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
  createMints,
  partnerPda,
  poolPda,
  positionPda,
  setupUser,
  tokenBalance,
  u,
  vaultPda,
} from "../scripts/common";

const PRICE = 5.4;
const PRICE_RAW = new anchor.BN(5_400_000);

async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    const got = e?.error?.errorCode?.code ?? e?.message ?? String(e);
    expect(String(got)).to.contain(code);
    return;
  }
  expect.fail(`esperava o erro ${code}`);
}

describe("cambi_pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CambiPool as Program<CambiPool>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;

  let mints: Mints;
  let pool: PublicKey;
  let brlVault: PublicKey;
  let usdVault: PublicKey;
  let alice: User; // Rende em reais
  let bob: User; // Rende em dólar
  let whale: User; // Baleia nas duas moedas
  let carol: User; // varejo
  let app: User; // app parceiro (B2B)

  const deposit = (user: User, tranche: number, side: number, amount: number) =>
    program.methods
      .deposit(tranche, side, u(amount))
      .accountsPartial({
        user: user.kp.publicKey,
        pool,
        position: positionPda(pid, pool, user.kp.publicKey, tranche, side),
        brlVault,
        usdVault,
        userBrl: user.brl,
        userUsd: user.usd,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user.kp])
      .rpc();

  const withdraw = (user: User, tranche: number, side: number, amount: number) =>
    program.methods
      .withdraw(u(amount))
      .accountsPartial({
        user: user.kp.publicKey,
        pool,
        position: positionPda(pid, pool, user.kp.publicKey, tranche, side),
        brlVault,
        usdVault,
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
    opts: { position?: PublicKey; partner?: PublicKey; minOut?: number; poolKey?: PublicKey; vaults?: [PublicKey, PublicKey] } = {},
  ) =>
    program.methods
      .swap(side, u(amount), u(opts.minOut ?? 0))
      .accountsPartial({
        user: user.kp.publicKey,
        pool: opts.poolKey ?? pool,
        brlVault: opts.vaults?.[0] ?? brlVault,
        usdVault: opts.vaults?.[1] ?? usdVault,
        userBrl: user.brl,
        userUsd: user.usd,
        depositorPosition: opts.position ?? null,
        partner: opts.partner ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.kp])
      .rpc();

  /** Taxa efetiva paga numa troca de reais por dólar, medida pelos saldos. */
  async function feeRateBrlToUsd(user: User, amount: number, opts: Parameters<typeof swap>[3] = {}) {
    const before = await tokenBalance(connection, user.usd);
    await swap(user, BRL, amount, opts);
    const received = (await tokenBalance(connection, user.usd)) - before;
    return 1 - (received * PRICE) / amount;
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

  it("inicializa o pool com cofres e configuração padrão", async () => {
    await program.methods
      .initialize(PRICE_RAW, new anchor.BN(3600))
      .accountsPartial({
        admin: admin.publicKey,
        brlMint: mints.brl,
        usdMint: mints.usd,
        pool,
        brlVault,
        usdVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const p = await program.account.pool.fetch(pool);
    expect(p.price.toString()).to.equal(PRICE_RAW.toString());
    expect(p.brlVault.toBase58()).to.equal(brlVault.toBase58());
    expect(p.fees.retailBps).to.equal(100);
    expect(p.paused).to.equal(false);
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
    // Tira reais do pool com trocas de dólar por real até sobrar pouco além do principal da Rende.
    for (let i = 0; i < 3; i++) await swap(carol, USD, 2_500);
    await expectError(withdraw(whale, BALEIA, BRL, 20_000), "BaleiaJuniorLiquidity");
    // Um saque pequeno, que mantém a Rende coberta, passa.
    await withdraw(whale, BALEIA, BRL, 100);
  });

  it("pausa trocas e depósitos, mas mantém saques liberados", async () => {
    await program.methods.setPaused(true).accountsPartial({ admin: admin.publicKey, pool }).rpc();
    await expectError(swap(carol, BRL, 100), "Paused");
    await expectError(deposit(carol, RENDE, BRL, 100), "Paused");
    await withdraw(alice, RENDE, BRL, 1);
    await program.methods.setPaused(false).accountsPartial({ admin: admin.publicKey, pool }).rpc();
    await swap(carol, BRL, 100);
  });

  it("só o oráculo atualiza o preço e só o admin muda as taxas", async () => {
    await expectError(
      program.methods.setPrice(new anchor.BN(1)).accountsPartial({ oracle: carol.kp.publicKey, pool }).signers([carol.kp]).rpc(),
      "ConstraintHasOne",
    );
    await program.methods.setPrice(new anchor.BN(5_500_000)).accountsPartial({ oracle: admin.publicKey, pool }).rpc();
    const p = await program.account.pool.fetch(pool);
    expect(p.price.toNumber()).to.equal(5_500_000);
    await expectError(
      program.methods.updateFees({ ...p.fees, retailBps: 600 }).accountsPartial({ admin: admin.publicKey, pool }).rpc(),
      "InvalidConfig",
    );
  });

  it("recusa trocas com cotação desatualizada", async () => {
    const m2 = await createMints(connection, admin);
    const pool2 = poolPda(pid, m2.brl, m2.usd);
    const v2: [PublicKey, PublicKey] = [vaultPda(pid, pool2, m2.brl), vaultPda(pid, pool2, m2.usd)];
    await program.methods
      .initialize(PRICE_RAW, new anchor.BN(1))
      .accountsPartial({
        admin: admin.publicKey,
        brlMint: m2.brl,
        usdMint: m2.usd,
        pool: pool2,
        brlVault: v2[0],
        usdVault: v2[1],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const dave = await setupUser(connection, admin, m2, { brl: 1_000, usd: 0 }, { kp: Keypair.generate(), airdropSol: 1 });
    await new Promise((r) => setTimeout(r, 3_000));
    await expectError(swap(dave, BRL, 100, { poolKey: pool2, vaults: v2 }), "StalePrice");
  });
});
