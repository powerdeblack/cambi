// Regras de conformidade do app (versão de hackathon, pensada como se fosse operar de verdade).
// Mapa das normas e do que falta para produção: docs/CONFORMIDADE.md.
// Os dados ficam só no aparelho; em produção, a verificação é feita por um provedor de KYC do parceiro regulado.
import type { Side } from "./engine/pool";

export type Suitability = "conservador" | "moderado" | "arrojado";

export interface Profile {
  name: string;
  cpf: string; // só dígitos
  birth: string; // AAAA-MM-DD
  pep: boolean; // pessoa exposta politicamente (Circular BCB 3.978)
  sourceOfFunds: string;
  usPerson: boolean; // FATCA
  otherTaxResidency: string; // CRS: outro país de residência fiscal, se houver
  verifiedAt?: number;
  suitability?: { profile: Suitability; at: number };
  termsAcceptedAt?: number;
}

export const EMPTY_PROFILE: Profile = { name: "", cpf: "", birth: "", pep: false, sourceOfFunds: "", usPerson: false, otherTaxResidency: "" };

// ---------- CPF ----------

export const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** Valida os dois dígitos verificadores do CPF (e recusa sequências repetidas como 111.111.111-11). */
export function isValidCpf(input: string): boolean {
  const c = onlyDigits(input);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(c[9]) && digit(10) === Number(c[10]);
}

export const formatCpf = (s: string) =>
  onlyDigits(s)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");

/** CPF mascarado para exibir (LGPD: mostra só o necessário). */
export const maskCpf = (s: string) => {
  const c = onlyDigits(s);
  return c.length === 11 ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : "";
};

export function ageOn(birth: string, now = new Date()): number {
  const b = new Date(`${birth}T12:00:00`);
  if (Number.isNaN(b.getTime())) return -1;
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

/** Problemas do cadastro, por campo. Vazio = pode verificar. */
export function profileErrors(p: Profile, now = new Date()): Partial<Record<keyof Profile, string>> {
  const e: Partial<Record<keyof Profile, string>> = {};
  if (p.name.trim().split(/\s+/).length < 2) e.name = "Digite o nome completo, como no documento.";
  if (!isValidCpf(p.cpf)) e.cpf = "CPF inválido.";
  const age = ageOn(p.birth, now);
  if (age < 0) e.birth = "Data inválida.";
  else if (age < 18) e.birth = "A conta é só para maiores de 18 anos.";
  if (!p.sourceOfFunds) e.sourceOfFunds = "Escolha a origem principal do seu dinheiro.";
  return e;
}

export const SOURCES_OF_FUNDS = [
  "Salário ou pró-labore",
  "Trabalho autônomo ou freelance",
  "Investimentos",
  "Aposentadoria ou pensão",
  "Herança ou doação",
  "Venda de bens",
  "Mesada ou ajuda da família",
];

// ---------- Limites ----------

/** Limite por operação, em reais: conta não verificada opera pouco (regra de PLD/FT, proporcional ao risco). */
export const LIMITS = { unverified: 1_000, verified: 50_000 } as const;

export const isVerified = (p: Profile) => Boolean(p.verifiedAt);
export const limitFor = (p: Profile) => (isVerified(p) ? LIMITS.verified : LIMITS.unverified);

/** Mensagem se a operação passa do limite da conta (valor convertido para reais). */
export function limitProblem(p: Profile, amountBRL: number): string | null {
  const limit = limitFor(p);
  if (amountBRL <= limit + 1e-9) return null;
  const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  return isVerified(p)
    ? `Acima do limite por operação (${brl(limit)}). Divida em mais de uma operação.`
    : `Contas não verificadas operam até ${brl(limit)} por vez. Verifique sua identidade no perfil para liberar até ${brl(LIMITS.verified)}.`;
}

// ---------- Finalidade da operação de câmbio ----------

/** Natureza da operação: o câmbio no Brasil registra o motivo de cada troca (Lei 14.286/2021 e Res. BCB 277/2022). */
export const PURPOSES = [
  { id: "viagem", label: "Viagem internacional" },
  { id: "estudo", label: "Estudos no exterior" },
  { id: "compras", label: "Compras ou serviços no exterior" },
  { id: "reserva", label: "Reserva de valor em dólar" },
  { id: "familia", label: "Ajuda a familiares no exterior" },
  { id: "trabalho", label: "Recebimento por trabalho no exterior" },
  { id: "outro", label: "Outro" },
] as const;
export type Purpose = (typeof PURPOSES)[number]["id"];

// ---------- Perfil de investidor (Res. CVM 30/2021) ----------

export const SUITABILITY_QUESTIONS = [
  {
    id: "objetivo",
    q: "Qual é o seu objetivo com a Rende?",
    a: ["Guardar sem perder dinheiro", "Ganhar um pouco mais que a poupança", "Buscar ganhos maiores, aceitando oscilação"],
  },
  { id: "prazo", q: "Por quanto tempo pretende deixar o dinheiro?", a: ["Menos de 6 meses", "De 6 meses a 2 anos", "Mais de 2 anos"] },
  {
    id: "perda",
    q: "Se o seu dinheiro em dólar caísse 10% num mês, você:",
    a: ["Resgataria tudo", "Esperaria recuperar", "Aproveitaria para aplicar mais"],
  },
] as const;

/** Soma das respostas (0, 1 ou 2 cada): até 2 conservador, até 4 moderado, acima arrojado. */
export function suitabilityFrom(answers: number[]): Suitability {
  const score = answers.reduce((s, a) => s + a, 0);
  return score <= 2 ? "conservador" : score <= 4 ? "moderado" : "arrojado";
}

/** A Rende em dólar oscila com o câmbio: inadequada para perfil conservador (o app avisa e pede ciência). */
export const rendeMismatch = (s: Suitability | undefined, side: Side) => s === "conservador" && side === "USD";

// ---------- Envios de cripto: Travel Rule (GAFI/FATF, Recomendação 16) e sanções ----------

/** A partir de US$ 1.000, o envio de cripto leva os dados de quem envia e de quem recebe. */
export const TRAVEL_RULE_USD = 1_000;
export const travelRuleApplies = (route: string, amountUSD: number) => route === "usdc" && amountUSD >= TRAVEL_RULE_USD;

/**
 * Lista de bloqueio de DEMONSTRAÇÃO (endereços inventados para teste).
 * Em produção: triagem por provedor de análise on-chain e listas oficiais (OFAC, ONU, Conselho de Segurança e listas do COAF).
 */
export const DEMO_SANCTIONED = new Set([
  "75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz2d", // bytes 0x5a repetidos: endereço de teste
  "C9cmcgqgaD1P1wGjyHpc1SLsHCiD8VHJCKyGciPrGyDe", // bytes 0xa5 repetidos: endereço de teste
]);
export const isSanctioned = (address: string) => DEMO_SANCTIONED.has(address.trim());

// ---------- Armazenamento (só no aparelho) ----------

const KEY = "cambi-profile-v1";

export function loadProfile(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (p && typeof p === "object") return { ...EMPTY_PROFILE, ...p, cpf: onlyDigits(String(p.cpf ?? "")) };
  } catch {
    /* sem armazenamento */
  }
  return EMPTY_PROFILE;
}

export function saveProfile(p: Profile | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* navegação privada */
  }
}
