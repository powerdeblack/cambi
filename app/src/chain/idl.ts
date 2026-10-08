// Igual ao idl/cambi_pool.json (o teste chain.test.ts confere). Discriminador Anchor = sha256("global:<nome>")[0..8].
export const DISCRIMINATOR = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  faucet_claim: [37, 228, 249, 8, 75, 106, 198, 114],
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
  6016: "Variação da cotação acima do limite por atualização",
  6017: "Depósito ainda no período mínimo antes do resgate",
  6018: "Limite de saída do pool neste minuto atingido; tente em instantes",
  6019: "Depósito mínimo de R$ 10",
  6020: "Esta carteira não é o admin proposto",
  6021: "As duas moedas precisam ter as mesmas casas decimais",
  6022: "Só a autoridade de upgrade do programa pode fazer isso",
  6023: "Moedas de teste: aguarde 1 hora entre pedidos",
  6024: "Moedas de teste só para quem tem menos de R$ 100",
  6025: "Limite de moedas de teste desta hora atingido; tente mais tarde",
};
