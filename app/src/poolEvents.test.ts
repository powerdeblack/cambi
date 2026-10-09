import { describe, expect, it } from "vitest";
import { decodeEvent, earningsCurve, eventsFromLogs, ownersEarnedBRL, toBase58 } from "./poolEvents";

const u64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(v * 1e6)), true);
  return [...b];
};
const key = new Uint8Array(32).fill(7);

function swapBytes(sideIn: number, amountIn: number, amountOut: number, fee: number, toRende: number, toBaleia: number, price: number) {
  return new Uint8Array([
    64, 198, 205, 232, 38, 8, 113, 226,
    ...key,
    sideIn,
    ...u64(amountIn), ...u64(amountOut), ...u64(fee), ...u64(toRende), ...u64(toBaleia), ...u64(0.1), ...u64(0.2), ...u64(price),
  ]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

describe("eventos do pool", () => {
  it("decodifica SwapEvent", () => {
    const e = decodeEvent(swapBytes(0, 100, 19.7, 1, 0.18, 0.42, 5.02), "sig1", 1000)!;
    expect(e.kind).toBe("swap");
    if (e.kind !== "swap") return;
    expect(e.amountIn).toBe(100);
    expect(e.toBaleia).toBeCloseTo(0.42);
    expect(e.price).toBeCloseTo(5.02);
    expect(e.user).toBe(toBase58(key));
  });

  it("decodifica DepositEvent e ignora outras linhas", () => {
    const dep = new Uint8Array([120, 248, 61, 83, 31, 142, 107, 144, ...key, 0, 0, ...u64(100)]);
    const evts = eventsFromLogs(["Program log: Instruction: Deposit", `Program data: ${b64(dep)}`, "Program data: ????"], "s", 5);
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ kind: "deposit", amount: 100, tranche: 0 });
  });

  it("base58 igual ao da Solana (chave de zeros = 32 uns)", () => {
    expect(toBase58(new Uint8Array(32))).toBe("1".repeat(32));
  });

  it("soma o que foi pago aos donos, convertendo dólar em reais", () => {
    const a = decodeEvent(swapBytes(0, 100, 19.7, 1, 0.2, 0.4, 5), "a", 1)!;
    const b = decodeEvent(swapBytes(1, 20, 99, 0.2, 0.02, 0.04, 5), "b", 2)!;
    expect(ownersEarnedBRL([a, b])).toBeCloseTo(0.6 + 0.06 * 5);
  });

  it("a curva de rendimento termina no valor exato e ignora trocas antes do depósito", () => {
    const evts = [1, 2, 3].map((t) => decodeEvent(swapBytes(0, 100, 19.7, 1, 0.2, 0.4, 5), `s${t}`, t * 100)!);
    const c = earningsCurve(evts, 150, 0.9);
    expect(c.map((p) => p.at)).toEqual([150, 200, 300]);
    expect(c[c.length - 1].value).toBeCloseTo(0.9);
    expect(c[1].value).toBeCloseTo(0.45);
  });
});

describe("addMarks", () => {
  it("põe cada marca sobre a curva, no valor acumulado até ali", async () => {
    const { addMarks } = await import("./poolEvents");
    const curve = [
      { at: 100, value: 0 },
      { at: 200, value: 1 },
      { at: 300, value: 3 },
    ];
    const r = addMarks(curve, [
      { at: 100, label: "depósito" },
      { at: 250, label: "depósito 2" },
      { at: 50, label: "fora" },
    ]);
    expect(r.points.map((p) => p.value)).toEqual([0, 1, 1, 3]);
    expect(r.markers).toEqual([
      { i: 0, label: "depósito" },
      { i: 2, label: "depósito 2" },
    ]);
  });
});
