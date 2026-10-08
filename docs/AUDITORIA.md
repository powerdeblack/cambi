# Auditoria de segurança (revisão interna)

**Data:** 8 de outubro de 2026 · **Escopo:** programa Solana `programs/cambi_pool`, app (`app/`), scripts e
GitHub Actions · **Resultado:** todos os achados altos e médios corrigidos e cobertos por testes; os baixos estão
corrigidos ou aceitos com justificativa, conforme as tabelas abaixo.

> Esta é uma revisão interna e independente do código, não uma auditoria externa paga. Antes de qualquer dinheiro
> real, o programa passa por auditoria externa (ver "Antes da mainnet").

## Como foi feita

1. **Revisão manual do programa**: cada instrução e cada restrição de conta. Contas falsas, assinaturas, aritmética,
   ataques econômicos (liquidez relâmpago, oráculo, senioridade da Rende), reinicialização e CPIs.
2. **Revisão do app e da infraestrutura**: montagem das transações, chaves, XSS, CSP, workflows (gatilhos,
   permissões, cache, ações de terceiros, instaladores) e scripts.
3. **Dependências**: `cargo audit` (RustSec) e `npm audit`, agora automáticos toda semana e a cada push.
4. **Cada correção ganhou um teste** que reproduz o ataque e prova que ele falha. Ao todo:
   - 23 testes de integração numa Solana local;
   - 12 testes de unidade no programa;
   - 39 testes no app;
   - teste de ponta a ponta contra a devnet, pelo cliente e pelas telas num navegador real.

## Programa (Solana)

| ID | Gravidade | Achado | Correção | Prova |
|---|---|---|---|---|
| H-1 | Alta | A Baleia (júnior) conseguia sacar numa moeda deixando a Rende (sênior) sem cobertura na outra moeda | O saque da Baleia exige que **os dois cofres** continuem cobrindo o principal da Rende | Teste "ataque da auditoria (H-1)" |
| M-1 | Média | Sem trava: depositar, trocar no limite de 20% e sacar, tudo numa transação, drenava o cofre. Várias trocas seguidas também drenavam | **Trava de resgate** do principal (10 min na devnet) e **limite de saída acumulado por minuto** (20% da liquidez do início da janela) | Testes "trava o resgate" e "limita a saída acumulada por minuto" |
| M-2 | Média | Liquidez relâmpago: entrar só para pegar a taxa de uma troca grande e sair em seguida | A mesma trava de resgate: o capital fica exposto por pelo menos 10 min | Teste "trava o resgate" |
| M-3 | Média | Oráculo sem limite: uma chave comprometida podia mudar o preço para qualquer valor | **Variação máxima por atualização** (10%), checada no programa; validade da cotação ajustável (1 h na devnet); depósitos também recusam cotação velha | Testes de oráculo e de cotação velha |
| M-4 | Média | Qualquer um podia criar primeiro o pool de um par de moedas e controlá-lo | `initialize` só aceita a **autoridade de upgrade do programa** e exige as mesmas casas decimais nas duas moedas | Teste "só a autoridade de upgrade cria pools" |
| L-1 | Baixa | O desconto de depositante saía com um depósito de 1 centavo | Depósito mínimo e posição mínima de **R$ 10** para o desconto | Teste "recusa depósito abaixo de R$ 10" |
| L-2 | Baixa | Depósito aceitava cotação velha | Depósito exige cotação válida | Teste de cotação velha |
| L-3 | Baixa | Depósitos minúsculos podiam inflar o acumulador de taxas | Depósito mínimo de R$ 10 e multiplicações checadas | Testes de unidade |
| L-4 | Baixa | `saturating_sub` escondia diferenças de arredondamento nas taxas | A taxa paga nunca passa do que está reservado, então arredondamento nunca sai do principal | Revisão e testes |
| I-1 | Info | Contas de destino do saque sem checagem de dono | `token::authority = user` | Revisão |
| I-2 | Info | Sem troca de admin | Troca de admin **em dois passos** (propor e aceitar) | Teste "troca de admin só em dois passos" |
| I-3/I-4 | Info | Truncamento e aritmética sem checagem | `checked_*` e conversão com saturação | Revisão |

Extras aplicados:
- **`security.txt`** embutido no programa, com contato e política de divulgação.
- **Faucet de testes só na versão devnet**: a feature `devnet` fica de fora do build de produção. O CI confere que o
  binário de produção não tem as instruções de faucet.

**Verificado como seguro** (sem mudança necessária):
- não dá para trocar o cofre por outro, porque o cofre é um PDA amarrado ao pool;
- não dá para usar a posição de outra pessoa para ganhar desconto;
- não dá para falsificar parceiro B2B;
- o programa de token é fixo;
- as seeds dos PDAs estão corretas;
- não há reinicialização via `init_if_needed`;
- não há divisão por zero;
- a pausa mantém os saques liberados.

## App, infraestrutura e chaves

| ID | Gravidade | Achado | Correção |
|---|---|---|---|
| H1 | Alta | A chave de admin da devnet (que também é autoridade de upgrade) ficava num cache que workflows de pull request podiam ler | Nenhum workflow roda código de pull request de forks. Chaves separadas: o **oráculo** usa só a dele (a de admin é apagada do disco no job). O cache é restaurado só depois de instalar dependências |
| M1 | Média | Chave da carteira patrocinadora pública no app, com poder de emitir moedas de teste | **Removida.** As moedas de teste agora vêm de um **faucet do próprio programa**, com regras na blockchain: 1 pedido por hora, só para quem tem menos de R$ 100, teto global por hora, emissão por PDA. O SOL das taxas vem do faucet público da Solana. A chave antiga foi **desativada**: perdeu a autoridade de emissão e o SOL voltou ao admin |
| M2 | Média | Código de terceiros sem versão fixa nos workflows com chaves | Todas as ações fixadas por **hash de commit**; Agave em versão fixa com **hash do instalador conferido**; `npm ci --ignore-scripts`; token do GitHub não fica salvo no disco; Playwright travado no lockfile |
| L1 | Baixa | O limite de slippage não estava ligado ao valor que a pessoa viu | O mínimo aceito é 99,5% do **valor mostrado na tela**; se a cotação piorou, a troca é recusada antes de assinar |
| L2 | Baixa | Oráculo de uma fonte só | **Consenso**: mediana das fontes que concordam a até 2% (Coinbase, Mercado Bitcoin, AwesomeAPI e ExchangeRate-API), mínimo de 2 concordando, cotação velha descartada. Somado ao limite de 10% no programa |
| L3 | Baixa | Dados pessoais (nome, chave Pix) em memos públicos e no armazenamento do aparelho | O memo leva só um **código de referência**; o aparelho guarda só dados mascarados (e endereço de carteira, que é público) |
| L4 | Baixa | Chave da conta invisível guardada no navegador | Aceito **só na devnet** (vale só moeda de teste); opção "apagar minha conta deste aparelho". Mainnet: carteira embutida com passkey/MPC |
| L5 | Baixa | Sem CSP e sem proteção contra moldura (clickjacking) | **CSP** no build publicado; a página se recusa a rodar dentro de iframe; `referrer: no-referrer` |
| L6 | Baixa | O app não conferia se a rede é mesmo a devnet | Antes de assinar, o app confere o **hash do bloco gênese** da devnet e exige `cluster: devnet` |
| L7 | Baixa | Vulnerabilidades conhecidas em dependências | O app deixou de usar `@solana/spl-token` (que trazia `bigint-buffer`): instruções de token montadas à mão e conferidas byte a byte. `TransferChecked` no lugar de `Transfer`. Auditoria de dependências automática e Dependabot |

Outros endurecimentos:
- a Phantom só é aceita via `window.phantom.solana`, e a reconexão é silenciosa (sem abrir janela sozinha);
- envio USDC só para carteiras de verdade, nunca para endereço de programa;
- links da blockchain codificados;
- dados do armazenamento validados antes do uso.

## Riscos aceitos (com justificativa)

- **`cargo audit`**: 3 avisos sem vulnerabilidade, herdados do SDK da Solana/Anchor e que não rodam dentro do programa:
  - `bincode` sem manutenção;
  - `libsecp256k1` sem manutenção;
  - `rand 0.7.3`, que só é unsound com logger customizado.
- **`npm audit` do app**: avisos moderados em `jayson`, `uuid` e `stream-json`, dentro do web3.js 1.x. O caminho
  vulnerável não é usado no navegador. Some com a migração para `@solana/kit`.
- **Chaves de devnet no cache do GitHub Actions**: só workflows deste repositório, disparados por quem tem acesso
  de escrita, conseguem ler o cache. Para a mainnet, as chaves ficam fora do CI (abaixo).

## Antes da mainnet (obrigatório)

1. **Auditoria externa** do programa e programa de recompensa por falhas (bug bounty).
2. **Autoridade de upgrade e admin numa multisig** (Squads), com timelock para upgrades.
3. **Pyth lido pelo próprio programa**, com checagem de confiança e de validade (substitui o oráculo por script).
4. **Carteira embutida** (passkey/MPC) e **pagador de taxas no servidor** com limites por conta.
5. **Parceiro regulado (SPSAV)** custodiando a ponta do Pix, com reconciliação.
6. **Build verificável** (`solana-verify`), para qualquer pessoa conferir que o binário na rede é este código.
7. Build **sem a feature `devnet`**, conferido pelo CI.
