# Checklist da submissão (Colosseum Crypto World's Fair)

**Prazo:** 13/10/2026 às 06:59 UTC (**03:59 da madrugada de 13/10, horário de Brasília**). Mire em enviar no dia 12 à noite.

Fonte dos requisitos: FAQ oficial ([colosseum.com/hackathon](https://colosseum.com/hackathon)),
"What is the required information in the submission portal?" e "How will submissions be judged?".

## O que o portal pede

| Item pedido | Status | O que fazer |
|---|---|---|
| Conta no Colosseum e entrada no hackathon | ⬜ Você | colosseum.com/signup → entrar no Crypto World's Fair. Cada membro do time cria a própria conta; o líder adiciona os outros na submissão |
| Nome e descrição curta do produto | ⬜ Você escreve | Use as perguntas-guia abaixo |
| Blockchains e ferramentas usadas | ✅ Pronto | Solana, Anchor 0.31, SPL Token; React/Vite/TypeScript na demo |
| Time: membros, histórico e experiência | ⬜ Você | Sua trajetória como dev e por que este problema importa para você |
| Localização do time | ⬜ Você | Cidade/estado |
| Logo ou imagem do produto | ✅ Pronto | [`brand/logo.svg`](../brand/logo.svg) e [`brand/icon.svg`](../brand/icon.svg) (exporte em PNG se o portal pedir) |
| Link do GitHub | ✅ Pronto | https://github.com/powerdeblack/cambi (público) |
| Programa na devnet | ✅ Pronto | `AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ` · provas no [README](../README.md#na-devnet-ao-vivo) |
| Demo no ar | ✅ Pronto | https://powerdeblack.github.io/cambi/ (aba Pool lê a devnet ao vivo) |
| Vídeo de apresentação (2–3 min) | ⬜ Você grava | Estrutura abaixo |
| Vídeo de demo (até 3 min) | ⬜ Você grava | Roteiro de telas abaixo |
| Go-to-market, validação de demanda e distribuição | ⬜ Você escreve | Perguntas-guia abaixo + resultados de [VALIDACAO.md](VALIDACAO.md) |
| Declarar trabalho pré-existente | ✅ | Nenhum: todo o código foi criado durante o hackathon |

> Os textos da submissão precisam ser **seus**: os juízes leem como as palavras do time. Abaixo há perguntas e
> estruturas para guiar, não textos prontos.

## Como os juízes avaliam (e onde a cambI responde)

| Critério | Onde está a resposta |
|---|---|
| Fit fundador–mercado | Sua história como dev + a missão de tornar o câmbio compreensível ([MARCA.md](MARCA.md)) |
| Insight | O spread é invisível; dois públicos com fluxos opostos podem trocar entre si via pool; quem deposita deve ficar com o lucro |
| Produto e execução | Demo funcional + programa on-chain com testes |
| Tamanho de mercado | Câmbio de pessoas físicas e PMEs no Brasil; apps de pagamento com stablecoin (B2B) |
| Comunicação | Vídeos claros, README direto |
| Viabilidade | [ECONOMIA.md](ECONOMIA.md): duas camadas, quatro fontes de receita, parceiro regulado |
| Tração | Conversas de validação ([VALIDACAO.md](VALIDACAO.md)): mesmo poucas, contam |

## Perguntas-guia para os textos

**Descrição curta:** O que a cambI faz em uma frase? Para quem? O que ninguém mais faz?

**Go-to-market:**
1. Quem são os primeiros 100 usuários e onde eles estão?
2. Por que os apps de pagamento com stablecoin seriam o primeiro canal de volume?
3. O que você aprendeu nas conversas de validação? Quantas pessoas, o que disseram, o que surpreendeu?
4. Qual parceiro regulado você procuraria primeiro e por quê?
5. O que precisa ser verdade para o modelo funcionar (giro mínimo, tamanho do pool)?

## Vídeo de apresentação (2–3 min): estrutura

| Tempo | Bloco | Conteúdo |
|---|---|---|
| 0:00–0:20 | Quem é você | Dev; o que te fez olhar para o câmbio |
| 0:20–0:50 | Problema | Spread invisível; quanto custa trocar R$ 5.000 no banco vs. casa de câmbio |
| 0:50–1:30 | Solução | O nome (câmbio + I); pool com Rende e Baleia; "para onde foi o seu dinheiro" |
| 1:30–2:10 | Negócio | Quem paga, quem ganha, de onde vem o volume (B2B), receita da cambI |
| 2:10–2:40 | Riscos e regulação | Parceiro SPSAV, sem FGC, por que isso gera confiança |
| 2:40–3:00 | Fechamento | Próximos passos e o slogan |

Dicas: grave em pé, com luz de frente, frases curtas. Mostre o logo no início e no fim.

## Vídeo de demo (até 3 min): roteiro de telas

1. **Trocar:** enviar R$ 500 como "não sou depositante" → mostrar a cotação e a taxa antes de confirmar.
2. **Para onde foi o seu dinheiro?:** a barra colorida e a comparação com banco e casa de câmbio.
3. **Pool ao vivo:** fazer uma troca grande e mostrar o pool ficando desequilibrado e a mensagem de taxa mais barata no sentido contrário.
4. **Participar:** depositar R$ 10 na Rende → mostrar o aviso de "sem FGC". Mostrar a Baleia.
5. **Simular:** mexer no movimento diário e mostrar a Rende passando do CDI e a Baleia subindo.
6. **Código:** abrir `programs/cambi_pool/src/lib.rs` (função `swap` e `quote`) e rodar `cargo test` e `npm test`.

Dica: grave a tela do celular ou do navegador em modo celular (largura ~420px).

## Antes de enviar

- [x] Repositório público e README atualizado
- [x] Demo publicada (GitHub Pages) e link testado
- [x] Programa implantado na devnet com transações de prova
- [ ] Campos do portal atualizados com o endereço do programa na devnet
- [ ] Os dois vídeos enviados (YouTube não listado ou Loom) e links testados em janela anônima
- [ ] Textos revisados por outra pessoa
- [ ] Enviar até 12/10 à noite
