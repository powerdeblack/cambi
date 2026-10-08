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
│  • deposit/withdraw: taxas nas 2 moedas por valor (shares)   │
│  • Rende sênior, limite por troca, pausa de emergência       │
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
| `programs/cambi_pool` | Programa on-chain em Rust/Anchor 0.31 | 9 testes unitários (`cargo test`) + testes de integração numa Solana local (`anchor test`) no GitHub Actions; **implantado na devnet** em `AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ` pelo workflow `deploy-devnet.yml` (endereços em `deployments/devnet.json`) |
| `tests/` | Testes de integração (TypeScript, mocha) | Fluxo completo e cada regra de segurança |
| `scripts/` | Utilitários e montagem do pool de demonstração na devnet | Registra cada transação como prova |
| `app/` | Demo web (React + Vite + TypeScript) com motor do pool em TypeScript | Funcional, com testes (Vitest); simula o pool no navegador e lê o pool real da devnet na aba Pool |
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

**Participação nas taxas por valor:** cada depósito recebe *shares* iguais ao seu valor em reais no momento do
depósito (dólar convertido pela cotação). Cada camada tem um acumulador `acc_fee_per_share` por moeda da taxa, e
cada posição guarda `reward_debt` nas duas moedas. Assim, quem depositou dólar também recebe as taxas pagas em reais
(e vice-versa), na proporção do valor que colocou. Taxas pendentes são pagas em todo depósito e saque (sacar 0 =
só colher as taxas).

**Rende sênior:** a Baleia só consegue sacar se, depois do saque, a liquidez livre do cofre continuar maior ou igual
a todo o principal da Rende naquela moeda (`BaleiaJuniorLiquidity`). A Rende saca sempre que houver liquidez.

**Limites e emergência:** uma troca leva no máximo 20% da liquidez de saída (`TradeTooLarge`). O admin pode pausar
trocas e depósitos (`Paused`), mas **saques continuam liberados** para ninguém ficar preso. Mudanças de taxa passam por
`FeeConfig::validate` (nenhuma taxa base acima de 5%, multiplicador dinâmico até 3x, limite por troca obrigatório).

## Limitações desta versão (honestas)

- **Oráculo:** o preço vem de uma autoridade definida pelo admin (com checagem de cotação velha). Na devnet, o
  workflow "Oráculo da devnet" grava a cotação real do dólar a cada 15 minutos (Coinbase, com AwesomeAPI e
  ExchangeRate-API de reserva) e recusa variação acima de 10% entre leituras. Produção: Pyth (que tem feed USD/BRL)
  lido direto pelo programa, com o mesmo disjuntor de variação dentro do programa.
- **Risco de câmbio do principal:** cada posição saca o principal na moeda que depositou. A prioridade da Rende cobre
  a **liquidez**; a absorção completa de perdas de desequilíbrio pela Baleia (marcação a mercado das posições) é a
  próxima etapa.
- **Parte aplicada em renda fixa** (CDI tokenizado / T-bill tokenizado): roadmap. Hoje os cofres guardam só a parte líquida.
- **Entrada e saída via Pix:** dependem do parceiro regulado; na devnet usamos moedas de teste (cBRL e cUSD).
- O programa **não foi auditado**. Não use com dinheiro real.

## Segurança

- PDAs: `pool = [b"pool", brl_mint, usd_mint]`, cofres `[b"vault", pool, mint]`,
  posições `[b"position", pool, user, tranche, side]`, parceiros `[b"partner", pool, authority]`.
- Somente o oráculo atualiza o preço; somente o admin registra parceiros e coleta taxas da operação.
- Proteção contra slippage com `min_out` e limite de 20% da liquidez por troca.
- Cofres fixados na conta do pool (`has_one`), posições verificadas por seeds e dono.
- Desconto de depositante e de parceiro provados por contas on-chain; posição de outra pessoa é recusada.
- Aritmética com `u128` e verificações de overflow.

## Como rodar

```bash
# Demo web
cd app && npm install && npm run dev      # http://localhost:5173
npm test                                  # testes do motor do pool

# Testes unitários do programa (sem Solana CLI)
cargo test -p cambi_pool

# Testes de integração numa Solana local (requer Solana CLI + Anchor 0.31)
npm install
anchor keys sync && anchor test
```

**Deploy na devnet:** GitHub → Actions → "Deploy na devnet" → Run workflow. O workflow compila, implanta, monta um
pool de demonstração com depósitos e trocas reais e grava os endereços e as transações em `deployments/devnet.json`.
Se faltar SOL de devnet, o resumo do workflow mostra o endereço para pedir no faucet.
