// Saída do dinheiro depois da troca: Pix (reais) ou conta em dólar.
// Na demo nada é enviado de verdade; em produção, Pix via parceiro autorizado pelo Banco Central (SPSAV) e
// dólar via parceiro bancário nos EUA (ACH), transferência internacional para qualquer país (SWIFT) ou direto na
// carteira do cliente (USDC na Solana).

export type PixKeyType = "cpf" | "celular" | "email" | "aleatoria";
export type UsdRoute = "ach" | "swift" | "usdc";

export const PIX_KEY_LABEL: Record<PixKeyType, string> = {
  cpf: "CPF",
  celular: "Celular",
  email: "E-mail",
  aleatoria: "Chave aleatória",
};

export const USD_ROUTE = {
  ach: { label: "Conta bancária nos EUA", fee: 1, eta: "1 dia útil", via: "ACH, por parceiro bancário" },
  swift: { label: "Conta em outro país", fee: 15, eta: "1 a 3 dias úteis", via: "SWIFT, por banco correspondente" },
  usdc: { label: "Carteira digital (USDC)", fee: 0, eta: "em segundos", via: "rede Solana" },
} as const;

const digits = (s: string) => s.replace(/\D/g, "");

/** CPF com dígitos verificadores. */
export function isValidCpf(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

/** Devolve a mensagem de erro, ou null se a chave é válida. */
export function pixKeyError(type: PixKeyType, value: string): string | null {
  const v = value.trim();
  if (!v) return "Informe a chave Pix";
  switch (type) {
    case "cpf":
      return isValidCpf(v) ? null : "CPF inválido";
    case "celular": {
      const d = digits(v).replace(/^55(?=\d{10,11}$)/, "");
      return /^[1-9]{2}9?\d{8}$/.test(d) ? null : "Celular inválido (use DDD + número)";
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : "E-mail inválido";
    case "aleatoria":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? null : "Chave aleatória inválida";
  }
}

/** Esconde parte da chave no comprovante, como fazem os bancos. */
export function maskPixKey(type: PixKeyType, value: string): string {
  const v = value.trim();
  if (type === "cpf") {
    const d = digits(v);
    return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  }
  if (type === "celular") {
    const d = digits(v).replace(/^55(?=\d{10,11}$)/, "");
    return `(${d.slice(0, 2)}) *****-${d.slice(-4)}`;
  }
  if (type === "email") {
    const [user, domain] = v.split("@");
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return `${v.slice(0, 8)}-****-****-****-${v.slice(-4)}`;
}

/** Número de roteamento ABA (bancos dos EUA): 9 dígitos com dígito verificador. */
export function isValidRouting(value: string): boolean {
  const d = digits(value);
  if (d.length !== 9) return false;
  const n = d.split("").map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}

export function achError(holder: string, routing: string, account: string): string | null {
  if (holder.trim().length < 3) return "Informe o nome do titular da conta";
  if (!isValidRouting(routing)) return "Routing number inválido (9 dígitos)";
  if (!/^\d{4,17}$/.test(digits(account)) || digits(account) !== account.trim()) return "Número da conta inválido";
  return null;
}

/** Endereço Solana: base58, 32 a 44 caracteres. */
export function solanaAddressError(value: string): string | null {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim()) ? null : "Endereço de carteira Solana inválido";
}

/** Identificador fim a fim no formato do Pix (32 caracteres): E + ISPB + data/hora + sequência. */
export function pixEndToEndId(now = new Date(), random = Math.random): string {
  const ispb = "00000000"; // demo: sem instituição real
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let seq = "";
  for (let i = 0; i < 11; i++) seq += chars[Math.floor(random() * chars.length)];
  return `E${ispb}${stamp}${seq}`;
}

// ---------- Transferência internacional (SWIFT) ----------

/** Países mais comuns para quem sai do Brasil. iban = o país usa IBAN; blocked = sanções amplas (ONU/OFAC). */
export const COUNTRIES = [
  { code: "PT", name: "Portugal", iban: true },
  { code: "ES", name: "Espanha", iban: true },
  { code: "FR", name: "França", iban: true },
  { code: "DE", name: "Alemanha", iban: true },
  { code: "IT", name: "Itália", iban: true },
  { code: "IE", name: "Irlanda", iban: true },
  { code: "NL", name: "Holanda", iban: true },
  { code: "GB", name: "Reino Unido", iban: true },
  { code: "CH", name: "Suíça", iban: true },
  { code: "AE", name: "Emirados Árabes", iban: true },
  { code: "AR", name: "Argentina", iban: false },
  { code: "CL", name: "Chile", iban: false },
  { code: "UY", name: "Uruguai", iban: false },
  { code: "PY", name: "Paraguai", iban: false },
  { code: "MX", name: "México", iban: false },
  { code: "CO", name: "Colômbia", iban: false },
  { code: "CA", name: "Canadá", iban: false },
  { code: "JP", name: "Japão", iban: false },
  { code: "AU", name: "Austrália", iban: false },
  { code: "CU", name: "Cuba", iban: false, blocked: true },
  { code: "IR", name: "Irã", iban: true, blocked: true },
  { code: "KP", name: "Coreia do Norte", iban: false, blocked: true },
  { code: "SY", name: "Síria", iban: true, blocked: true },
] as const;
export type CountryCode = (typeof COUNTRIES)[number]["code"];
export const countryOf = (code: string) => COUNTRIES.find((c) => c.code === code);

/** IBAN: país + 2 dígitos verificadores (módulo 97, ISO 13616). */
export function isValidIban(value: string): boolean {
  const v = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** Código SWIFT/BIC: banco (4 letras), país (2), local (2) e agência opcional (3). */
export const isValidBic = (value: string) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value.trim().toUpperCase());

export interface SwiftFields {
  holder: string;
  country: string;
  account: string; // IBAN ou número da conta
  bic: string;
}

/** Erros por campo, ou objeto vazio se dá para enviar. */
export function swiftErrors(f: SwiftFields): Partial<Record<keyof SwiftFields, string>> {
  const e: Partial<Record<keyof SwiftFields, string>> = {};
  const c = countryOf(f.country);
  if (f.holder.trim().split(/\s+/).length < 2) e.holder = "Nome completo de quem recebe, como está no banco";
  if (!c) e.country = "Escolha o país";
  else if ("blocked" in c && c.blocked) e.country = `Não enviamos para ${c.name}: o país está sob sanções internacionais.`;
  else if (c.iban) {
    const iban = f.account.replace(/\s+/g, "").toUpperCase();
    if (!isValidIban(iban)) e.account = "IBAN inválido";
    else if (!iban.startsWith(c.code)) e.account = `Esse IBAN não é de ${c.name}`;
  } else if (!/^[A-Za-z0-9-]{5,34}$/.test(f.account.trim())) e.account = "Número da conta inválido";
  if (!isValidBic(f.bic)) e.bic = "Código SWIFT/BIC inválido (8 ou 11 caracteres)";
  else if (c && f.bic.trim().toUpperCase().slice(4, 6) !== c.code) e.bic = `Esse SWIFT não é de um banco de ${c?.name}`;
  return e;
}

/** Final do IBAN ou da conta, para mostrar no comprovante. */
export const maskAccount = (v: string) => {
  const s = v.replace(/\s+/g, "").toUpperCase();
  return s.length > 8 ? `${s.slice(0, 4)} •••• ${s.slice(-4)}` : s;
};

/** Rastreio de transferência SWIFT (UETR, formato UUID). */
export const uetr = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000";
