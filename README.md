<p align="center">
  <img src="brand/logo.svg" alt="cambI" height="72" />
</p>

<h3 align="center">O câmbio sou eu.</h3>

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

- **Troca instantânea** real ↔ dólar digital, a preço de oráculo, com a taxa mostrada antes de confirmar.
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
| [`programs/cambi_pool`](programs/cambi_pool) | Programa Solana em Rust/Anchor 0.31 | ✅ Compila para a Solana (SBF, 371 KB) · 9 testes unitários |
| [`tests/`](tests) | Testes de integração numa Solana local | ✅ 15 testes passando no [GitHub Actions](../../actions/workflows/solana.yml) |
| [`scripts/`](scripts) | Montagem do pool de demonstração na devnet | ✅ Pronto · ⏳ aguardando SOL de devnet para o deploy |
| [`app/`](app) | Demo web (React + Vite + TypeScript) | ✅ [No ar](https://powerdeblack.github.io/cambi/) · 10 testes |
| [`sim/`](sim) | Simulação econômica (Python) | ✅ |
| [`docs/`](docs) | [Arquitetura](docs/ARQUITETURA.md) · [Economia](docs/ECONOMIA.md) · [Marca](docs/MARCA.md) · [Validação](docs/VALIDACAO.md) · [Colosseum](docs/COLOSSEUM.md) | ✅ |

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

## Licença

[MIT](LICENSE)
