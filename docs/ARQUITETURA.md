# Arquitetura

```
┌────────────┐   Pix (reais)    ┌──────────────────────┐
│  Usuário   │ ───────────────► │  Parceiro regulado   │  SPSAV autorizada pelo Banco Central:
│  (app/web) │ ◄─────────────── │  (on/off-ramp)       │  KYC, Pix, conversão real <-> stablecoin
└─────┬──────┘                  └──────────┬───────────┘
      │ assina transações                   │ real digital / USDC
      ▼                                     ▼
┌──────────────────────────────────────────────────────────────┐
│ Programa Solana `cambi_pool` (Anchor)                        │
│  • Pool: cofre BRL + cofre USD, preço de oráculo             │
│  • Camadas: Rende (varejo) e Baleia (liquidez qualificada)   │
│  • swap: taxa dinâmica + divisão Rende/Baleia/parceiro/cambI │
│  • deposit/withdraw com acumulador de taxas por posição      │
└──────────────────────────────────────────────────────────────┘
      ▲                                     ▲
      │ preço (reais por dólar)             │ liquidez B2B (roadmap)
┌─────┴──────┐                     ┌────────┴─────────┐
│  Oráculo   │                     │ Apps de pagamento│
└────────────┘                     └──────────────────┘
```

## Componentes

| Pasta | O que é | Estado |
|---|---|---|
| `programs/cambi_pool` | Programa on-chain em Rust/Anchor 0.31 | Compila (build nativo) e passa nos testes unitários da lógica de preço e taxas; build SBF e deploy em devnet ainda não feitos |
| `app/` | Demo web (React + Vite + TypeScript) com motor do pool em TypeScript | Funcional, com testes (Vitest); simula o pool no navegador |
| `sim/` | Simulação econômica em Python | Gera as tabelas de [ECONOMIA.md](ECONOMIA.md) |

## Regras do pool

**Preço:** `price` = reais por dólar × 10^6, atualizado pela autoridade de oráculo. Trocas são recusadas se a
cotação tiver mais de `max_price_age` segundos (`StalePrice`). Em produção, usar Pyth ou Switchboard.

**Taxa base por tipo de cliente** (provado por contas, não por argumento):

| Cliente | Como o programa reconhece | Taxa |
|---|---|---|
| Depositante | conta `depositor_position` do próprio usuário com saldo > 0 | 0,5% |
| App parceiro (B2B) | conta `partner` registrada pelo admin para a carteira | 0,4% |
| Varejo | nenhuma das anteriores | 1,0% |

**Taxa dinâmica:** `taxa = base × clamp(1 + desequilíbrio, 0,7, 1,5)`. O desequilíbrio é a diferença entre o valor
em reais e em dólares no pool. Trocar no sentido que piora o desequilíbrio fica mais caro; no sentido que corrige,
mais barato. Assim os próprios usuários rebalanceiam o pool.

**Divisão da taxa** (padrões em `FeeConfig::default`):
1. Parceiro regulado: 0,2% sobre a parte do volume que passa pelo Pix
2. Do restante: 25% cambI (operação)
3. Do que sobra (provedores de liquidez): 70% Baleia, 30% Rende

As taxas ficam no cofre da moeda de entrada e são reservadas (`available()` desconta taxas pendentes), então nunca
são usadas como liquidez de troca.

**Acumulador de taxas:** padrão "reward per share". Cada camada/moeda tem `acc_fee_per_share`; cada posição guarda
`reward_debt`. Taxas pendentes são pagas em todo depósito e saque.

## Simplificações desta versão (honestas)

- As taxas de uma troca vão para quem depositou a **moeda que entrou** na troca. A versão de produção deve dividir
  por valor entre as duas moedas.
- A **proteção da Rende pela Baleia** (primeira perda em caso de desequilíbrio) está no modelo econômico e na demo,
  mas ainda não está implementada on-chain.
- A parte "aplicada" em renda fixa (CDI tokenizado / T-bill tokenizado) é roadmap; hoje os cofres guardam só a parte líquida.
- Saques dependem de haver liquidez na moeda depositada.
- O programa **não foi auditado**. Não use com dinheiro real.

## Segurança

- PDAs: `pool = [b"pool", brl_mint, usd_mint]`, cofres `[b"vault", pool, mint]`,
  posições `[b"position", pool, user, tranche, side]`, parceiros `[b"partner", pool, authority]`.
- Somente o oráculo atualiza o preço; somente o admin registra parceiros e coleta taxas da operação.
- Proteção contra slippage com `min_out`.
- Aritmética com `u128` e verificações de overflow.

## Como rodar

```bash
# Demo web
cd app && npm install && npm run dev      # http://localhost:5173
npm test                                  # testes do motor do pool

# Programa on-chain (testes da lógica pura, sem precisar da Solana CLI)
cargo test -p cambi_pool

# Build/deploy em devnet (requer Solana CLI + Anchor 0.31)
anchor keys sync && anchor build && anchor deploy --provider.cluster devnet
```
