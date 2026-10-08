// Gerado a partir de idl/cambi_pool.json (o teste chain.test.ts confere que continua igual ao IDL).
export const DISCRIMINATOR = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;

/** Mensagens de erro do programa (códigos 6000+). */
export const PROGRAM_ERRORS: Record<number, string> = {
  6000: "Preço inválido",
  6001: "Configuração inválida",
  6002: "Cotação desatualizada",
  6003: "Valor precisa ser maior que zero",
  6004: "Moeda inválida",
  6005: "Camada inválida",
  6006: "Cofre não corresponde à moeda",
  6007: "Liquidez insuficiente no pool",
  6008: "A Baleia só saca se o cofre continuar cobrindo o principal da Rende",
  6009: "Troca maior que o limite por operação",
  6010: "Pool pausado: trocas e depósitos suspensos",
  6011: "Saldo da posição insuficiente",
  6012: "Recebido abaixo do mínimo aceito",
  6013: "Parceiro inválido",
  6014: "Posição inválida",
  6015: "Estouro numérico",
};
