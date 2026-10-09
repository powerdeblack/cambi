<p align="center">
  <img src="brand/logo.svg" alt="cambI" height="72" />
</p>

<h3 align="center">O câmbio sou eu.</h3>

<p align="center"><a href="README.md">English</a> · <b>Português</b></p>

<p align="center">
  Casa de câmbio on-chain (real ↔ dólar) em que os clientes são os donos.<br/>
  Troca na hora, 24h, com a conta inteira à mostra. E quem deixa dinheiro no pool ganha com as trocas dos outros.
</p>

---

## O problema

Quando um brasileiro troca real por dólar, o spread é invisível e fica todo com o intermediário: mais de 5% no banco
e perto de 4% em casas de câmbio. Fintechs baixaram o custo, mas o cliente continua sendo só cliente. A maioria das
pessoas nunca soube quanto pagou, nem para quem.

## A solução

**cambI** = câmbio + **I** ("eu", em inglês).

- **Troca instantânea** real ↔ dólar digital, **na cotação real do dólar** (ao vivo no app; gravada no pool da devnet várias vezes ao dia), com a taxa mostrada antes de confirmar.
- **A outra ponta da troca:** os reais saem por **Pix** para qualquer chave e os dólares vão para uma **conta nos EUA** (ACH) ou uma **carteira USDC** na Solana, com revisão, comprovante e contatos recentes (simulado na demo).
- **"Para onde foi o seu dinheiro?"**: toda troca mostra a divisão da taxa e quanto custaria no banco ou na casa de câmbio.
- **Pool com duas camadas:**
  - 🟢 **cambI Rende** (qualquer pessoa, a partir de R$ 10): quase tudo aplicado em renda fixa, mais parte das taxas. Protegida: perdas de desequilíbrio caem primeiro na Baleia.
  - 🐋 **cambI Baleia** (investidores qualificados): é o motor de liquidez, assume o risco e recebe a maior fatia das taxas.
- **Taxa dinâmica:** fica mais barata no sentido que equilibra o pool, mais cara no que desequilibra.
- **Alinhamento:** a cambI só cobra performance da Rende sobre o que passar de 100% do CDI.

| Quem | Paga para trocar | Ganha (simulação, giro de 5%/dia) |
|---|---|---|
| Varejo | 1,0% | — |
| Depositante | 0,5% | Rende em reais: ~108% do CDI · em dólar: ~1,4× o T-bill |
| Baleia | — | ~27% a.a., assumindo o risco de desequilíbrio |
| App parceiro (B2B) | 0,4% | Liquidez real ↔ dólar 24h |

Premissas, fontes e riscos em [docs/ECONOMIA.md](docs/ECONOMIA.md). **Simulações não são promessa de rendimento.**

## O que está neste repositório

| Pasta | Conteúdo | Estado |
|---|---|---|
| [`programs/cambi_pool`](programs/cambi_pool) | Programa Solana em Rust/Anchor 0.31 | ✅ Compila para a Solana (SBF, 502 KB) · 12 testes unitários · revisão de segurança |
| [`tests/`](tests) | Testes de integração numa Solana local | ✅ 23 testes passando no [GitHub Actions](../../actions/workflows/solana.yml) |
| [`scripts/`](scripts) | Montagem do pool de demonstração na devnet | ✅ [Implantado na devnet](#na-devnet-ao-vivo) |
| [`app/`](app) | App web (React + Vite + TypeScript), instalável no celular | ✅ [No ar](https://powerdeblack.github.io/cambi/) · 39 testes · transações reais na devnet |
| [`sim/`](sim) | Simulação econômica (Python) | ✅ |
| [`docs/`](docs) | [Arquitetura](docs/ARQUITETURA.md) · [Economia](docs/ECONOMIA.md) · [Mercado](docs/MERCADO.md) · [Marca](docs/MARCA.md) · [Validação](docs/VALIDACAO.md) · [Colosseum](docs/COLOSSEUM.md) | ✅ |

### O que os testes de integração comprovam

Rodando o programa de verdade numa Solana local:

- Depósitos nas duas camadas, com participação nas taxas pelo **valor em reais** (quem deposita dólar também recebe as taxas pagas em reais)
- Taxa de varejo (1%), **desconto de depositante (0,5%)** e **taxa B2B (0,4%)** provados por contas on-chain
- Posição de outra pessoa não vale como desconto
- Saque devolve principal **e** taxas acumuladas
- **Rende sênior:** a Baleia não consegue sacar se deixar a Rende descoberta
- Limite de 20% da liquidez por troca, proteção de slippage
- **Pausa de emergência** bloqueia trocas e depósitos, mas **saques continuam liberados**
- Só o oráculo muda o preço; só o admin muda taxas, e dentro de limites
- Troca recusada com cotação desatualizada

## Na devnet, ao vivo

O programa (versão 2, com as correções da [auditoria](docs/AUDITORIA.md)) está na **Solana devnet** e o pool de
demonstração foi montado com transações reais. Qualquer pessoa pode conferir no Solana Explorer:

- **Programa:** [`AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ`](https://explorer.solana.com/address/AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ?cluster=devnet)
- **Pool:** [`BM342uKMYgDQ2hWmhuXnC4JdHtmWAN3kprptRgRxC3pg`](https://explorer.solana.com/address/BM342uKMYgDQ2hWmhuXnC4JdHtmWAN3kprptRgRxC3pg?cluster=devnet)
- **Oráculo** (chave própria, separada do admin): `HyU5mJweYbRU5wc8CCqXQ2VXBU5WGk1WYsyNFjCtzrwM`. Grava a cotação por consenso de fontes várias vezes ao dia (agendado no GitHub Actions, que costuma atrasar; por isso a cotação vale 24 h na devnet, com limite de 10% por atualização)

| Operação | Prova |
|---|---|
| Pool v2 criado (R$ 5.0090 por dólar), só pela autoridade de upgrade | [ver transação](https://explorer.solana.com/tx/5YPpYMHbND3mxSmcEreRXTLGB7AcFUUQj2wnXVFZE78rj7Qu4PXrRSKBkXpXEjGko4vviYpFVhfDupiCAkxsWx9o?cluster=devnet) |
| Limites: cotação vale 1 h (hoje 24 h), oráculo move até 10% por vez, depósito travado 10 min | [ver transação](https://explorer.solana.com/tx/5umpEub3GQfQ3WrNwdRW42QuLkHGGyWykPRf3AhhdxXuw9QyTs9xA2GHAbcgsLBJWbag3yV7GNfv124HzBcdaNbX?cluster=devnet) |
| Oráculo com chave própria (separada do admin) | [ver transação](https://explorer.solana.com/tx/2oWCkWdCnmgxYpyF2gcR1GsPKfrWXRmmJQjLhqqUCScjaFLF9yipUJLN8TgQTcbC9Dx5NHCdWPeLdQHVVFfuursm?cluster=devnet) |
| Depósito Rende: R$ 50.000 | [ver transação](https://explorer.solana.com/tx/5NXVEY8MQrssHC3N6sYhpuVF8ZszUBjbf6yCKbq9cQ9XTdMFQXEXPmPyt5vHc33qTss43YaTvN4pUnwNRYoXHuDc?cluster=devnet) |
| Depósito Rende: US$ 10.000 | [ver transação](https://explorer.solana.com/tx/JfjXzvygnoWbFZ3ZnPyev6F6zWpwTQ3zfZ53Sf2uZrLa3JWA1Y5pmsBRQtuMaNAqWST7yzoJhvEpFNpuyrWDALX?cluster=devnet) |
| Depósito Baleia: R$ 10.000 | [ver transação](https://explorer.solana.com/tx/YHB1JodEYje7AsCbUFqxaY2rdeEXG9Sa8uV9CxQSqkDBdM5mdK25JghhH1TuJUpT67nizPYZwKZRJGTx5ZwHsf5?cluster=devnet) |
| Depósito Baleia: US$ 2.000 | [ver transação](https://explorer.solana.com/tx/4SRzNa47ps2oJz1hCUt1Nmn1ho4To9ER2NVp25TEEzoTWnxRHZWU6824Xb2BAGGo1WHEbyTMZnHxT3xEYVDEojKB?cluster=devnet) |
| Troca varejo: R$ 1.000 → dólar (taxa 1%) | [ver transação](https://explorer.solana.com/tx/5Uv1y7AGCuvWgt3ur2MSUht2rWm3xDpdQWzXo7UsCtTuYUYwG13pZcnwGNpwQQdSdtXZy6j7Z98op2f7wtqP5eTt?cluster=devnet) |
| Troca depositante: R$ 1.000 → dólar (taxa 0,5%) | [ver transação](https://explorer.solana.com/tx/5Ajdt3f1UFP5BHjQJbhJiDQWZBp7VjUoYQ4g5vd3BZ2aU7XpW7xVFgzaY85dT5HmeQemXm92yBvEqtN6R9jcuHUW?cluster=devnet) |
| App parceiro registrado | [ver transação](https://explorer.solana.com/tx/Qb9whPf3LxnALJMmndT54nymcu8aunhGF6XzxtLtvLAro3dJ2XyjatqeG9BFuZsQSiUqQuxZyuG579LPWuw5swB?cluster=devnet) |
| Troca B2B: US$ 200 → real (taxa 0,4%) | [ver transação](https://explorer.solana.com/tx/5T7C894q7PnP4A3bXUJhDVz9HeJhsKK5gK8UekmHQHw8GVMJrCJfDh3Nxr2SeVnNr5oHfb5b71nTRLk1p7kBvyQc?cluster=devnet) |
| Depositante colhe as taxas (nas duas moedas) | [ver transação](https://explorer.solana.com/tx/BAkh9ewTFJ76xNiVxbzBQ9daGusoupGB3arzHanwZJWKG2xB61s1RCK8gFjVghLoZAL7ENUG6uRutvk9Xqq1wuh?cluster=devnet) |

Moedas de teste (cBRL e cUSD), sem valor real. Endereços completos em [`deployments/devnet.json`](deployments/devnet.json).

## O app usa a Solana de verdade (sem a pessoa perceber)

Na [demo](https://powerdeblack.github.io/cambi/), **"Criar minha conta grátis"** liga o app ao programa na devnet:

- **Conta invisível:** a conta na Solana é criada no próprio aparelho. Sem frase-semente, sem extensão, sem precisar
  de cripto. Quem já usa cripto pode escolher **"Prefiro usar minha Phantom"**.
- **Moedas de teste do próprio programa:** um faucet on-chain dá R$ 1.000 de teste (cBRL), com regras na blockchain
  (1 vez por hora, só para quem tem pouco saldo, teto global). O SOL das taxas vem do faucet público da Solana.
  Nenhuma chave com poder fica no app.
- **Tudo vira transação real:** troca, depósito na Rende, rendimento, resgate, Pix e envio em dólar. Cada comprovante
  tem o link **"ver na blockchain"**.
- **A prévia é a conta do programa:** o app calcula a troca com a mesma matemática do programa (porta fiel de
  `quote`, em inteiros), então o valor mostrado antes de confirmar é o valor recebido, centavo por centavo.

Comprovado automaticamente pelo workflow [Teste de ponta a ponta na devnet](../../actions/workflows/e2e-devnet.yml)
(roda a cada 6 horas):

1. **Cliente do app contra o programa real:** conta nova → troca (recebe exatamente a prévia) → depósito na Rende →
   troca como depositante (0,5%) → colher taxas (recebe exatamente o pendente) → envio USDC → Pix → resgate.
2. **As telas num navegador real:** cria a conta, troca, deposita e envia um Pix pela interface, esperando cada
   comprovante da Solana.

Em produção, a conta invisível vem de um provedor de carteira embutida (login com e-mail ou Google, confirmação por
biometria) e um servidor paga as taxas da rede. Nenhuma chave com poder vai para o app.

## Rodar localmente

```bash
# Demo web
cd app && npm install && npm run dev      # http://localhost:5173
npm test                                  # testes do motor do pool

# Testes unitários do programa (sem Solana CLI)
cargo test -p cambi_pool

# Testes de integração (requer Solana CLI + Anchor 0.31)
npm install && anchor build && anchor keys sync && anchor test

# Simulação econômica
python3 sim/cambi_sim.py
```

## Stack

Solana · Anchor 0.31 · SPL Token · React 18 · Vite · TypeScript · Mocha/Chai · Vitest · GitHub Actions · Python

## Segurança

Revisão de segurança completa do programa, do app e da infraestrutura, com cada ataque reproduzido num teste:
[docs/AUDITORIA.md](docs/AUDITORIA.md). Para relatar uma falha: [SECURITY.md](SECURITY.md).

- A Rende é sênior nas duas moedas; depósitos têm trava de resgate e há limite de saída por minuto
- O oráculo só move o preço até 10% por vez, por consenso de várias fontes, com chave separada do admin
- Só a autoridade de upgrade cria pools; a troca de admin é feita em dois passos
- Faucet de testes só na versão devnet (o CI confere que o binário de produção não o contém)
- Ações do GitHub fixadas por hash, nenhum código de fork roda com acesso às chaves, auditoria de dependências semanal

## Feito como se fosse de verdade: conformidade

O app se comporta como um produto regulado (versão de hackathon: rede de testes e parceiros simulados). Mapa completo
das normas brasileiras e internacionais em [docs/CONFORMIDADE.md](docs/CONFORMIDADE.md).

- **Cadastro (Lei 9.613 e Circular BCB 3.978):** CPF validado, maioridade, PEP e origem dos recursos; limite por
  operação para conta não verificada.
- **Câmbio (Lei 14.286 e Res. BCB 277):** finalidade de cada troca, VET e IOF estimado antes de confirmar.
- **Perfil de investidor (Res. CVM 30):** antes do primeiro depósito na Rende, com aviso de inadequação.
- **LGPD:** aceite ao criar a conta, política de privacidade, baixar e apagar meus dados, nada pessoal na blockchain.
- **Internacional:** Travel Rule do GAFI a partir de US$ 1.000, triagem de sanções e FATCA/CRS.

## Regulação e riscos

- **Descentralizado por dentro, regulado na porta:** entrada e saída via Pix devem ser feitas por uma SPSAV
  autorizada pelo Banco Central. Desde fevereiro de 2026 (Res. BCB 519/520/521), operações com stablecoin atrelada
  a moeda estrangeira são tratadas como câmbio.
- Rendimento para depositantes tende a ser enquadrado como oferta de investimento (CVM); a camada Baleia é pensada
  para investidores qualificados.
- **O dinheiro no pool não tem garantia do FGC.**
- O programa **não foi auditado**. Esta é uma versão de hackathon: não use com dinheiro real.
- Limitações conhecidas (oráculo, marcação a mercado da Baleia, renda fixa tokenizada) em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Hackathon

Projeto criado para o **Colosseum Crypto World's Fair** (inscrições até 13/10/2026). Todo o código foi escrito
durante o hackathon; não há trabalho pré-existente. Checklist da submissão em [docs/COLOSSEUM.md](docs/COLOSSEUM.md).

**Autoria:** fundador solo, [@powerdeblack](https://github.com/powerdeblack), de São Paulo. Desenvolvido com apoio de
IA: Claude Code no código e Colosseum Copilot na pesquisa, os dois declarados na submissão. As decisões de produto
são do fundador. Os primeiros commits aparecem com o autor "Claude" (a identidade padrão do agente de código); os
seguintes saem pela conta do fundador.

## Licença

[MIT](LICENSE)
