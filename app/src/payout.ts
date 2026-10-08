// Saída do dinheiro depois da troca: Pix (reais) ou conta em dólar.
// Na demo nada é enviado de verdade; em produção, Pix via parceiro autorizado pelo Banco Central (SPSAV) e
// dólar via parceiro bancário nos EUA (ACH) ou direto na carteira do cliente (USDC na Solana).

export type PixKeyType = "cpf" | "celular" | "email" | "aleatoria";
export type UsdRoute = "ach" | "usdc";

export const PIX_KEY_LABEL: Record<PixKeyType, string> = {
  cpf: "CPF",
  celular: "Celular",
  email: "E-mail",
  aleatoria: "Chave aleatória",
};

export const USD_ROUTE = {
  ach: { label: "Conta bancária nos EUA", fee: 1, eta: "1 dia útil", via: "ACH, por parceiro bancário" },
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
