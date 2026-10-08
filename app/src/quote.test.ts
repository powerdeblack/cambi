import { describe, expect, it } from "vitest";
import { LiveQuote, fetchConsensusQuote, fetchLiveQuote, isSanePrice } from "./quote";

const ok = (price: number, source = "A"): (() => Promise<LiveQuote>) => async () => ({ price, source, publishedAt: 1 });
const fail = (msg: string) => async (): Promise<LiveQuote> => {
  throw new Error(msg);
};

describe("cotação ao vivo", () => {
  it("usa a primeira fonte que responde", async () => {
    const q = await fetchLiveQuote([ok(5.43, "Coinbase"), ok(5.5, "B")]);
    expect(q).toMatchObject({ price: 5.43, source: "Coinbase" });
  });

  it("cai para a reserva quando a fonte principal falha", async () => {
    const q = await fetchLiveQuote([fail("fora do ar"), ok(5.41, "AwesomeAPI")]);
    expect(q.source).toBe("AwesomeAPI");
  });

  it("descarta preço absurdo e tenta a próxima fonte", async () => {
    const q = await fetchLiveQuote([ok(0.0001, "Quebrada"), ok(5.4, "Boa")]);
    expect(q.source).toBe("Boa");
  });

  it("avisa quando nenhuma fonte responde", async () => {
    await expect(fetchLiveQuote([fail("a"), fail("b")])).rejects.toThrow(/Nenhuma fonte/);
  });

  it("faixa de sanidade", () => {
    expect(isSanePrice(5.4)).toBe(true);
    expect(isSanePrice(NaN)).toBe(false);
    expect(isSanePrice(50)).toBe(false);
  });
});

describe("consenso do oráculo", () => {
  const at = (price: number, source: string, publishedAt = 1_000): (() => Promise<LiveQuote>) => async () => ({ price, source, publishedAt });
  const now = 1_000;

  it("usa a mediana das fontes que concordam", async () => {
    const c = await fetchConsensusQuote([at(5.0, "A"), at(5.02, "B"), at(5.04, "C")], { now });
    expect(c.price).toBe(5.02);
    expect(c.used).toHaveLength(3);
  });

  it("descarta a fonte que discorda (manipulada ou quebrada)", async () => {
    const c = await fetchConsensusQuote([at(5.0, "A"), at(5.02, "B"), at(6.5, "Hackeada")], { now });
    expect(c.used.map((q) => q.source)).toEqual(["A", "B"]);
    expect(c.price).toBeCloseTo(5.01);
  });

  it("não grava nada com uma fonte só", async () => {
    await expect(fetchConsensusQuote([at(5.0, "A"), async () => { throw new Error("fora"); }], { now })).rejects.toThrow(/insuficientes/);
  });

  it("descarta cotação velha", async () => {
    await expect(fetchConsensusQuote([at(5.0, "A"), at(5.0, "B", 0)], { now: 200_000 })).rejects.toThrow(/insuficientes/);
  });
});
