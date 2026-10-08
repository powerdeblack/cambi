import { describe, expect, it } from "vitest";
import { achError, isValidCpf, isValidRouting, maskPixKey, pixEndToEndId, pixKeyError, solanaAddressError } from "./payout";

describe("saída por Pix", () => {
  it("valida CPF pelos dígitos verificadores", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("529.982.247-26")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
  });

  it("valida cada tipo de chave", () => {
    expect(pixKeyError("celular", "(11) 98765-4321")).toBeNull();
    expect(pixKeyError("celular", "+55 11 98765-4321")).toBeNull();
    expect(pixKeyError("celular", "123")).not.toBeNull();
    expect(pixKeyError("email", "ana@exemplo.com.br")).toBeNull();
    expect(pixKeyError("email", "ana@")).not.toBeNull();
    expect(pixKeyError("aleatoria", "123e4567-e89b-12d3-a456-426614174000")).toBeNull();
    expect(pixKeyError("cpf", "")).toBe("Informe a chave Pix");
  });

  it("esconde parte da chave no comprovante", () => {
    expect(maskPixKey("cpf", "52998224725")).toBe("***.982.247-**");
    expect(maskPixKey("celular", "11987654321")).toBe("(11) *****-4321");
    expect(maskPixKey("email", "ana@exemplo.com")).toBe("an***@exemplo.com");
  });

  it("gera identificador fim a fim com 32 caracteres", () => {
    const id = pixEndToEndId(new Date(Date.UTC(2026, 9, 8, 14, 5)), () => 0);
    expect(id).toHaveLength(32);
    expect(id.startsWith("E00000000202610081405")).toBe(true);
  });
});

describe("saída em dólar", () => {
  it("valida routing number pelo dígito verificador", () => {
    expect(isValidRouting("021000021")).toBe(true); // JPMorgan Chase (NY)
    expect(isValidRouting("021000022")).toBe(false);
  });

  it("valida a conta nos EUA", () => {
    expect(achError("Ana Souza", "021000021", "123456789")).toBeNull();
    expect(achError("", "021000021", "123456789")).toMatch(/titular/);
    expect(achError("Ana Souza", "021000021", "12ab")).toMatch(/conta/);
  });

  it("valida endereço de carteira Solana", () => {
    expect(solanaAddressError("AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ")).toBeNull();
    expect(solanaAddressError("0xabc")).not.toBeNull();
  });
});
