import { describe, expect, it } from "vitest";
import { amountForTarget, buildPix, buildSolanaPay, crc16, parsePix, parseSolanaPay, readQr } from "./payqr";

describe("Pix (BR Code)", () => {
  it("CRC16/CCITT-FALSE confere com o valor de referência", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("monta e lê de volta um Pix com valor", () => {
    const code = buildPix({ key: "contato@cafe.com.br", name: "Café Ipanema", city: "Rio de Janeiro", amount: 150, txid: "PEDIDO42" });
    expect(code.startsWith("000201")).toBe(true);
    const p = parsePix(code);
    expect(p).toEqual({ key: "contato@cafe.com.br", name: "Cafe Ipanema", city: "Rio de Janeiro", amount: 150, txid: "PEDIDO42" });
  });

  it("Pix sem valor: quem paga digita", () => {
    const p = parsePix(buildPix({ key: "+5511987654321", name: "Maria", city: "SP" }));
    expect(p.amount).toBeUndefined();
    expect(p.txid).toBeUndefined();
  });

  it("recusa um código adulterado (CRC não confere)", () => {
    const code = buildPix({ key: "chave-aleatoria", name: "Loja", city: "SP", amount: 10 });
    const tampered = code.replace("10.00", "99.00");
    expect(() => parsePix(tampered)).toThrow(/CRC/);
  });

  it("recusa texto que não é Pix", () => {
    expect(() => parsePix("oi")).toThrow();
  });
});

describe("Solana Pay", () => {
  const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const usdc = "CKP5jr3A7Xt4pNwv9yMb9RvzeXK16Qme9QKD9DDcnGur";

  it("monta e lê de volta uma transferência em token", () => {
    const url = buildSolanaPay({ recipient: wallet, amount: 30.12, splToken: usdc, label: "cambI", message: "Café" });
    expect(url.startsWith(`solana:${wallet}?`)).toBe(true);
    expect(parseSolanaPay(url)).toMatchObject({ recipient: wallet, amount: 30.12, splToken: usdc, label: "cambI", message: "Café" });
  });

  it("recusa carteira inválida e valor inválido", () => {
    expect(() => parseSolanaPay("solana:xyz?amount=1")).toThrow(/Carteira/);
    expect(() => parseSolanaPay(`solana:${wallet}?amount=1e5`)).toThrow(/Valor/);
  });

  it("reconhece o tipo do código escaneado", () => {
    expect(readQr(buildSolanaPay({ recipient: wallet, amount: 1 })).kind).toBe("solana");
    expect(readQr(buildPix({ key: "k", name: "n", city: "c" })).kind).toBe("pix");
    expect(() => readQr("https://exemplo.com")).toThrow();
  });
});

describe("valor da troca para pagar um alvo", () => {
  it("escala pela cotação da prévia, com folga mínima", () => {
    // 10 dólares rendem 49,50 reais; para pagar R$ 150 precisa de ~30,30 dólares.
    expect(amountForTarget(150, 10, 49.5)).toBeCloseTo(30.32, 2);
  });
});
