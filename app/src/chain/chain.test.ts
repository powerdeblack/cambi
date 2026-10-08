import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FeeConfig, PoolRaw, chainQuote, decodePoolRaw, decodePositionRaw, pendingFees, swapBlocker } from "./accounts";
import { DISCRIMINATOR, PROGRAM_ERRORS } from "./idl";

const idl = JSON.parse(readFileSync(new URL("../../../idl/cambi_pool.json", import.meta.url), "utf8"));

const FEES: FeeConfig = {
  depositorBps: 50n,
  retailBps: 100n,
  b2bBps: 40n,
  depositorPixBps: 5_000n,
  retailPixBps: 10_000n,
  b2bPixBps: 2_000n,
  partnerCostBps: 20n,
  platformShareBps: 2_500n,
  baleiaShareBps: 7_000n,
  dynamicMinBps: 7_000n,
  dynamicMaxBps: 15_000n,
  maxTradeBps: 2_000n,
};

const pool = (over: Partial<PoolRaw> = {}): PoolRaw => ({
  price: 5_000_000n, // R$ 5,00
  priceUpdatedAt: 1_000,
  maxPriceAge: 3_600,
  fees: FEES,
  paused: false,
  principal: [0n, 0n, 0n, 0n],
  shares: [0n, 0n],
  accFeePerShare: [0n, 0n, 0n, 0n],
  lpFeesUnclaimed: [0n, 0n],
  platformFees: [0n, 0n],
  partnerFees: [0n, 0n],
  swapCount: 0n,
  volumeBrl: 0n,
  ...over,
});

const M = 1_000_000n;

describe("instruções iguais ao IDL do programa", () => {
  it("discriminadores conferem", () => {
    for (const name of ["swap", "deposit", "withdraw"] as const) {
      const ix = idl.instructions.find((i: { name: string }) => i.name === name);
      expect(Array.from(DISCRIMINATOR[name])).toEqual(ix.discriminator);
    }
  });

  it("mensagens de erro conferem", () => {
    for (const e of idl.errors) expect(PROGRAM_ERRORS[e.code]).toBe(e.msg);
  });

  it("ordem das contas da troca é a esperada pelo cliente", () => {
    const ix = idl.instructions.find((i: { name: string }) => i.name === "swap");
    expect(ix.accounts.map((a: { name: string }) => a.name)).toEqual([
      "user", "pool", "brl_vault", "usd_vault", "user_brl", "user_usd", "depositor_position", "partner", "token_program",
    ]);
  });
});

describe("cotação idêntica à do programa", () => {
  it("pool equilibrado: varejo paga 1% e a taxa se divide como no programa", () => {
    const q = chainQuote(pool(), 0, 1_000n * M, "retail", 50_000n * M, 10_000n * M);
    expect(q.feeBps).toBe(100n);
    expect(q.fee).toBe(10n * M);
    expect(q.amountOut).toBe(198n * M); // (1000 - 10) / 5
    expect(q.toPartner).toBe(2n * M); // 1000 × 100% Pix × 0,2%
    expect(q.toPlatform).toBe(2n * M); // 25% de 8
    expect(q.toBaleia).toBe(4_200_000n); // 70% de 6
    expect(q.toRende).toBe(1_800_000n);
    expect(q.toPartner + q.toPlatform + q.toBaleia + q.toRende).toBe(q.fee);
  });

  it("depositante paga metade", () => {
    const q = chainQuote(pool(), 0, 1_000n * M, "depositor", 50_000n * M, 10_000n * M);
    expect(q.fee).toBe(5n * M);
  });

  it("taxa sobe no sentido que desequilibra, com teto de 1,5x", () => {
    const sobraReal = chainQuote(pool(), 0, 1_000n * M, "retail", 90_000n * M, 2_000n * M);
    expect(sobraReal.feeBps).toBe(150n);
    const ajuda = chainQuote(pool(), 1, 100n * M, "retail", 90_000n * M, 2_000n * M);
    expect(ajuda.feeBps).toBe(70n);
  });

  it("recusa troca acima de 20% da liquidez de saída, como o programa", () => {
    const p = pool();
    const q = chainQuote(p, 0, 20_000n * M, "retail", 50_000n * M, 10_000n * M);
    expect(swapBlocker(p, 0, q, 50_000n * M, 10_000n * M, 1_500)).toMatch(/20%/);
    expect(swapBlocker(p, 0, q, 50_000n * M, 10_000n * M, 99_999)).toMatch(/desatualizada/);
  });

  it("taxas pendentes de uma posição", () => {
    const p = pool({ accFeePerShare: [3_000_000_000n, 0n, 0n, 0n] }); // 0,003 por share
    const pos = { owner: new Uint8Array(32), pool: new Uint8Array(32), tranche: 0, side: 0, amount: 100n * M, shares: 100n * M, rewardDebt: [100_000n, 0n] };
    expect(pendingFees(p, pos)).toEqual([200_000n, 0n]); // 0,30 acumulado − 0,10 já contabilizado
  });
});

describe("leitura das contas", () => {
  it("decodifica Pool e Position no layout Borsh do programa", () => {
    const bytes: number[] = [];
    const push = (n: bigint, size: number) => {
      for (let i = 0; i < size; i++) bytes.push(Number((n >> BigInt(8 * i)) & 0xffn));
    };
    push(0n, 8); // discriminador
    push(0n, 32 * 6);
    push(5_123_400n, 8); // price
    push(1_700_000_000n, 8);
    push(2_592_000n, 8);
    for (const v of Object.values(FEES)) push(v, 2);
    bytes.push(0); // paused
    [10n, 20n, 30n, 40n].forEach((v) => push(v, 8));
    [7n, 8n].forEach((v) => push(v, 16));
    [1n, 2n, 3n, 2n ** 70n].forEach((v) => push(v, 16));
    [11n, 12n, 13n, 14n, 15n, 16n].forEach((v) => push(v, 8));
    push(42n, 8);
    push(999n, 8);
    push(255n, 1);
    const p = decodePoolRaw(Uint8Array.from(bytes));
    expect(p.price).toBe(5_123_400n);
    expect(p.fees).toEqual(FEES);
    expect(p.principal).toEqual([10n, 20n, 30n, 40n]);
    expect(p.accFeePerShare[3]).toBe(2n ** 70n);
    expect(p.partnerFees).toEqual([15n, 16n]);
    expect(p.swapCount).toBe(42n);

    const pos: number[] = [];
    const pp = (n: bigint, size: number) => {
      for (let i = 0; i < size; i++) pos.push(Number((n >> BigInt(8 * i)) & 0xffn));
    };
    pp(0n, 8);
    pp(1n, 32);
    pp(2n, 32);
    pos.push(0, 1);
    pp(500n, 8);
    pp(600n, 16);
    pp(7n, 16);
    pp(8n, 16);
    pos.push(254);
    const d = decodePositionRaw(Uint8Array.from(pos));
    expect([d.tranche, d.side, d.amount, d.shares]).toEqual([0, 1, 500n, 600n]);
    expect(d.rewardDebt).toEqual([7n, 8n]);
  });
});
