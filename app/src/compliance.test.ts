import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE,
  LIMITS,
  ageOn,
  formatCpf,
  isSanctioned,
  isValidCpf,
  limitProblem,
  maskCpf,
  profileErrors,
  rendeMismatch,
  suitabilityFrom,
  travelRuleApplies,
} from "./compliance";

describe("CPF", () => {
  it("valida os dígitos verificadores", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("529.982.247-26")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(isValidCpf("123")).toBe(false);
  });
  it("formata e mascara", () => {
    expect(formatCpf("52998224725")).toBe("529.982.247-25");
    expect(maskCpf("52998224725")).toBe("***.982.247-**");
  });
});

describe("cadastro", () => {
  const ok = { ...EMPTY_PROFILE, name: "Maria Lima", cpf: "52998224725", birth: "1990-05-10", sourceOfFunds: "Salário ou pró-labore" };
  it("aceita cadastro completo de maior de idade", () => {
    expect(profileErrors(ok, new Date("2026-10-09"))).toEqual({});
  });
  it("recusa menor de idade, nome incompleto e CPF inválido", () => {
    const e = profileErrors({ ...ok, name: "Maria", cpf: "1", birth: "2010-01-01" }, new Date("2026-10-09"));
    expect(Object.keys(e).sort()).toEqual(["birth", "cpf", "name"]);
  });
  it("calcula a idade considerando o aniversário", () => {
    expect(ageOn("2008-10-10", new Date("2026-10-09T15:00:00"))).toBe(17);
    expect(ageOn("2008-10-09", new Date("2026-10-09T15:00:00"))).toBe(18);
  });
});

describe("limites por operação", () => {
  it("conta não verificada opera até R$ 1.000", () => {
    expect(limitProblem(EMPTY_PROFILE, LIMITS.unverified)).toBeNull();
    expect(limitProblem(EMPTY_PROFILE, LIMITS.unverified + 1)).toMatch(/Verifique sua identidade/);
  });
  it("conta verificada opera até R$ 50.000", () => {
    const v = { ...EMPTY_PROFILE, verifiedAt: 1 };
    expect(limitProblem(v, 20_000)).toBeNull();
    expect(limitProblem(v, 60_000)).toMatch(/Divida/);
  });
});

describe("perfil de investidor", () => {
  it("classifica pelas respostas", () => {
    expect(suitabilityFrom([0, 0, 1])).toBe("conservador");
    expect(suitabilityFrom([1, 1, 1])).toBe("moderado");
    expect(suitabilityFrom([2, 2, 1])).toBe("arrojado");
  });
  it("Rende em dólar é inadequada para conservador", () => {
    expect(rendeMismatch("conservador", "USD")).toBe(true);
    expect(rendeMismatch("conservador", "BRL")).toBe(false);
    expect(rendeMismatch("moderado", "USD")).toBe(false);
  });
});

describe("envios de cripto", () => {
  it("Travel Rule a partir de US$ 1.000, só para carteira", () => {
    expect(travelRuleApplies("usdc", 999.99)).toBe(false);
    expect(travelRuleApplies("usdc", 1000)).toBe(true);
    expect(travelRuleApplies("ach", 5000)).toBe(false);
  });
  it("bloqueia endereço da lista de sanções", () => {
    expect(isSanctioned("75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz2d")).toBe(true);
    expect(isSanctioned("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe(false);
  });
});
