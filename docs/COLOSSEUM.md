# Guia da submissão (Colosseum Crypto World's Fair)

**Prazo:** 13/10/2026 às 06:59 UTC (**03:59 da madrugada de 13/10, horário de Brasília**). Mire em enviar no dia 12
à noite. O portal só considera a submissão **enviada**; rascunho não conta.

Fontes: FAQ oficial do hackathon ([colosseum.com/hackathon](https://colosseum.com/hackathon)), nos itens "How will
submissions be judged?", "What is the required information in the submission portal?", "What do you look for in the
submitted Github repo?" e "Are Colosseum hackathons only for new products?".

> **Os textos da submissão precisam ser seus:** os jurados leem como as palavras do fundador. Aqui há fatos para
> conferir, perguntas para guiar e roteiros de vídeo, não textos prontos para colar.

## Regulamento: checagem

| Regra | Situação |
|---|---|
| Produto novo, sem investimento relevante | ✅ Todo o código foi feito durante o hackathon |
| Declarar trabalho pré-existente | ✅ Nenhum |
| Uma submissão por pessoa; fundador solo é permitido | ✅ |
| Qualquer blockchain | ✅ Solana |
| Repositório: aberto é incentivado | ✅ Público |
| Mostrar que **você** fez o trabalho (não um terceiro) | ✅ O uso de IA está declarado no portal e no README. Os commits novos saem pela conta [@powerdeblack](https://github.com/powerdeblack). Ligue o GitHub ao seu perfil na Colosseum |
| Código de conduta | ✅ |

## O que o portal pede

| Item | Situação | O que fazer |
|---|---|---|
| Nome, descrição, categoria (Payments & Remittance), país | ✅ | Revisar com os fatos atuais (abaixo) |
| Blockchains e ferramentas | ✅ | Incluir: faucet on-chain, oráculo por consenso, revisão de segurança |
| Link do GitHub e do produto | ✅ | https://github.com/powerdeblack/cambi · https://powerdeblack.github.io/cambi/ |
| Instruções de acesso ao produto | ⚠️ Atualizar | Hoje há dois modos: demonstração (abre direto) e conta real na devnet ("Criar minha conta grátis") |
| Como usa a Solana / contexto do repositório | ⚠️ Atualizar | O programa **está na devnet** (v2, revisado, com transações reais pelo app) |
| Time, experiência e localização | ⬜ Você | Perguntas-guia abaixo |
| Validação de demanda, tração, concorrência, monetização | ⬜ Você | Perguntas-guia abaixo + [VALIDACAO.md](VALIDACAO.md) |
| Vídeo de apresentação (2–3 min) | ⬜ Você grava | Roteiro abaixo. É um dos primeiros itens que os jurados veem |
| Vídeo de demo (até 3 min) | ⬜ Você grava | Roteiro abaixo |
| Atualizações semanais (vídeo de 1 min) | ⬜ Recomendado | Mesmo uma antes do prazo ajuda |
| Aceleradora | Decisão sua | Marcar interesse não obriga a nada se você ganhar |

## Fatos atuais para conferir nos campos (8/10)

- **Programa na devnet:** `AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ` (v2). O pool e as provas estão em
  [README](../README.md#live-on-devnet).
- **No app, tudo vira transação real:** troca, depósito na Rende, colher rendimento, resgate e envio (Pix, conta nos
  EUA e carteira USDC). Cada comprovante tem o link para o Explorer.
- **A prévia da troca usa a mesma conta do programa:** o valor mostrado é o valor recebido, provado em teste.
- **Moedas de teste:** saem de um faucet do próprio programa, com regras na blockchain. Nenhuma chave com poder fica
  no app.
- **Oráculo:** mediana de fontes que concordam, a cada 15 min, com chave própria e limite de 10% por atualização
  dentro do programa.
- **Segurança:** revisão interna achou 1 problema alto e 4 médios; todos corrigidos e testados
  ([AUDITORIA.md](AUDITORIA.md)). Ainda não há auditoria externa.
- **Testes:**
  - 23 de integração;
  - 12 de unidade no programa;
  - 39 no app;
  - ponta a ponta na devnet a cada 6 horas.

## Como os jurados avaliam (e onde a cambI responde)

| Critério | O que já existe | O que falta você trazer |
|---|---|---|
| Fit fundador–mercado | Missão de tornar o câmbio compreensível ([MARCA.md](MARCA.md)) | Sua história e o porquê, em primeira pessoa |
| Insight | Spread invisível; o cliente vira dono; regra de 2026 do BC (stablecoin = câmbio) | Dizer isso de forma explícita nos textos e no vídeo |
| Produto e execução | Programa na devnet, app com transações reais, revisão de segurança | Mostrar no vídeo de demo |
| Tamanho de mercado | [MERCADO.md](MERCADO.md): dados com fonte e conta transparente | Escolher 2 ou 3 números e dizer com suas palavras |
| Comunicação | README em inglês, com versão em português (README.pt-BR.md) | Os vídeos (com legenda em inglês) |
| Viabilidade | [ECONOMIA.md](ECONOMIA.md) | Preencher a monetização com suas palavras |
| Tração | Roteiro em [VALIDACAO.md](VALIDACAO.md) | Conversas reais e números: o maior buraco hoje |

## Perguntas-guia por campo

**Time e experiência**
- Há quanto tempo você programa e o que já entregou?
- O que você fez nestes dias de hackathon que mostra que executa rápido?
- Por que **você** quer resolver o câmbio? Teve alguma experiência pessoal com spread ou remessa?
- Quanto tempo você vai dedicar depois do hackathon?

**Validação de demanda**
- Com quantas pessoas você conversou, e de quais perfis (estudante, nômade, freelancer, pequena empresa)?
- Quanto elas pagam hoje para trocar e onde trocam?
- O que mais surpreendeu? Alguém pediu para usar ou entrar numa lista?

**Tração**
- Lista de espera, interessados, apps parceiros com quem falou? Números, mesmo que pequenos.

**Concorrência**
- Contra banco, Wise e Nomad, P2P da Binance: qual a diferença em uma frase?
- Um projeto de "exchange de moedas descentralizada" (FxSwap) já venceu em Pagamentos num hackathon anterior da
  Colosseum. O que a cambI tem que ele não tem? (dono do câmbio, Rende protegida pela Baleia, Pix regulado e app para
  leigos)

**Monetização**
- De onde vem a receita: 25% da taxa líquida e 20% do que a Rende render acima do CDI?
- Qual giro diário mínimo faz a conta fechar? Ver a simulação em [ECONOMIA.md](ECONOMIA.md).

**Tamanho de mercado:** os dados com fonte estão em [MERCADO.md](MERCADO.md).
- Gastos de brasileiros no exterior: US$ 21,7 bi em 2025.
- Cerca de 80% do volume cripto declarado é stablecoin.
- Regra de câmbio para stablecoins em vigor desde fev/2026.
- Use a conta transparente da seção 5 e cite a fonte de cada número.

**Por que agora**
- Resoluções do BC de fevereiro de 2026, Pix universal e stablecoins em dólar ganhando escala.

## Vídeo de apresentação (2–3 min): estrutura

| Tempo | Bloco | Conteúdo |
|---|---|---|
| 0:00–0:20 | Quem é você | Dev em São Paulo; o que te fez olhar para o câmbio |
| 0:20–0:50 | Problema | Spread invisível; quanto custa trocar R$ 5.000 no banco vs. casa de câmbio |
| 0:50–1:25 | Solução | cambI (câmbio + I); o cliente vira dono; Rende e Baleia; "para onde foi o seu dinheiro" |
| 1:25–1:50 | Por que agora e por que eu | Regra do BC de 2026, Pix, sua missão |
| 1:50–2:25 | Negócio e tração | Quem paga, quem ganha, receita; o que as conversas mostraram |
| 2:25–2:50 | Confiança | Parceiro regulado, sem FGC, revisão de segurança |
| 2:50–3:00 | Fechamento | Próximo passo e o slogan |

Dicas:
- Grave com luz de frente e frases curtas, mostrando o logo no início e no fim.
- **Coloque legenda em inglês**: os jurados são internacionais.

## Vídeo de demo (até 3 min): roteiro de telas

1. **Abrir o app no celular**, com a cotação ao vivo no topo.
2. **"Criar minha conta grátis"**: a conta na Solana nasce em segundos, com R$ 1.000 de teste do faucet do programa.
3. **Trocar R$ 100:** mostrar a prévia, confirmar, e no comprovante tocar em **"ver transação"** para abrir o Explorer
   (o momento mais forte do vídeo).
4. **Para onde foi a taxa:** a barra colorida e a comparação com o banco.
5. **Rende:** depositar R$ 100 e mostrar o aviso da trava de resgate (segurança); depois "Receber rendimento".
6. **Enviar Pix:** chave, valor, revisão e comprovante com link da blockchain.
7. **Código e segurança (20 s):** README em inglês, `docs/AUDITORIA.md` e os testes verdes no GitHub Actions.

Dica: grave a tela do celular ou o navegador em modo celular (largura de uns 420 px), **com legenda em inglês**.

## Antes de enviar

- [x] Repositório público, README em inglês (e versão em português) com declaração de autoria e IA
- [x] Demo publicada e programa na devnet com transações reais
- [x] Revisão de segurança publicada
- [ ] GitHub ligado ao perfil da Colosseum
- [ ] Campos "acesso ao produto", "como usa a Solana" e "contexto do repositório" atualizados
- [ ] Validação, tração, concorrência e monetização preenchidas com suas palavras
- [ ] Dois vídeos enviados (YouTube não listado ou Loom), com legenda em inglês e links testados em janela anônima
- [ ] Uma atualização semanal postada
- [ ] Textos revisados por outra pessoa
- [ ] **Submissão enviada** (não rascunho) até 12/10 à noite
