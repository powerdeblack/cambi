# Segurança do programa v2 (branch v2)

O programa avaliado (`AgZtr464…`) e o pool da submissão não mudam. O v2 é um programa **novo**, em outro endereço,
com as correções dos gargalos levantados na revisão de "regulado na porta, DEX por dentro".

| Gargalo | Correção no v2 | Onde |
|---|---|---|
| O programa aceitava qualquer carteira | **Credencial KYC on-chain** por carteira, emitida pelo parceiro regulado (`issue_credential`). Sem credencial válida não troca nem deposita. Nenhum dado pessoal vai para a blockchain: só nível, validade e quem emitiu | `check_credential`, `Credential` |
| Mesmo teto para todo mundo | **Teto por nível**: básico R$ 10 mil por operação, completo R$ 100 mil, institucional sem teto (ajustável dentro de limites) | `level_limit_brl` |
| Sanção/fraude sem resposta on-chain | **Revogação** pelo emissor ou pelo admin. A carteira revogada não troca mais, mas **continua podendo sacar** o que é dela | `revoke_credential` |
| Só havia limite por minuto nas trocas | **Disjuntor**: soma trocas e saques imediatos numa janela (padrão 1 h) e trava a saída acima de 30% da liquidez livre de cada moeda | `breaker_take` |
| Corrida no pool (todo mundo saca de uma vez) | **Saque imediato até 10%** da liquidez livre; acima disso, **fila com aviso prévio** (padrão 24 h; 10 min na devnet). O valor fica reservado no cofre e sai da liquidez das trocas | `request_withdraw`, `claim_withdraw`, `queued` |
| Uma chave admin fazia tudo | **Guardião**: chave de plantão que **só pausa**. Despausar, mudar preço, taxas ou regras continua com o admin, que é a **multisig 7 de 10** das Baleias | `guardian_pause` |
| Upgrade do programa numa chave só | Autoridade de upgrade passa para uma **multisig de upgrade** (mesmas 10 Baleias, 7 de 10) com **prazo de espera** de 1 h entre aprovar e executar | `scripts/consortium-v2.ts` |
| Lastro dos tokens sem verificação | **Prova de reserva**: o custodiante atesta a reserva de cada moeda on-chain. Se o total emitido passar da reserva ou o atestado vencer, trocas e depósitos param (saques seguem) | `attest_reserves`, `check_backing` |

## O que continua igual

- Saques **nunca** ficam bloqueados por pausa, por credencial revogada ou pelo disjuntor da fila: o que muda é o ritmo
  (imediato até o limite, o resto pela fila).
- Rende sênior, Baleia júnior, trava de depósito, limite de variação do oráculo e limite por troca seguem como no v1.

## Na devnet (rede de testes)

- O **emissor de KYC** é o deployer, simulando o parceiro regulado. No app há uma credencial básica de teste
  (`devnet_credential`, só existe no build `devnet`): a própria carteira pede, para dar para experimentar.
  No build de produção essa instrução não existe; o CI confere.
- A **prova de reserva** fica **desligada** na devnet: as moedas de teste não têm custodiante, então qualquer atestado
  seria inventado. Ela é testada nos testes de integração e se liga com `set_reserve_policy` quando houver lastro real.

## Lastro real (produção)

Candidatos, sujeitos à análise jurídica e regulatória de cada emissor:

- Dólar: USDC (Circle, reservas atestadas) ou PYUSD; dólar com rendimento: títulos do Tesouro americano tokenizados.
- Real: stablecoins de real (como BRLA e BRZ) e, no futuro, o Drex; real com rendimento: Tesouro Selic tokenizado por
  plataforma autorizada pela CVM.

Com lastro que rende, o dinheiro parado no pool ganha o juro básico e as taxas de câmbio viram um extra.

## Testes

- Rust (`cargo test`): KYC, teto por nível, disjuntor, fila de saque, prova de reserva e as regras antigas.
- Integração (`anchor test`, numa Solana local no CI): cada regra acima com transações reais, incluindo os ataques.

## Auditoria interna do v2 (v2.1)

Uma revisão independente do código v2 encontrou 8 pontos (nenhum crítico). Corrigidos no v2.1:

| Achado | Gravidade | Correção |
|---|---|---|
| Base do disjuntor inflável: depósito grande, janela recomeça, o valor sai pela fila e o teto fica alto | Média-alta | Base limitada a `livre + já saído`; o que entra na fila sai da base |
| Griefing: trocas de ida e volta enchem o disjuntor e travam todo mundo | Média | Disjuntor conta saída **líquida** (entrada da moeda abate a saída dela) |
| Trocar o emissor de KYC não invalidava credenciais antigas; validade sem teto | Média | Só vale credencial do emissor atual; validade máxima de 400 dias |
| Atestado de reserva de atestador antigo continuava valendo | Média | Só vale atestado do atestador atual |
| App parceiro B2B sem teto e sem como descredenciar | Média | Teto institucional por operação; `remove_partner` |
| CI não conferia a credencial de teste fora do binário de produção | Baixa-média | CI procura também `devnet_credential` e `admin_mint` |
| Reemitir credencial desfazia revogação | Baixa | Só o admin (multisig) restaura (`restore_credential`) |
| Aviso prévio da fila podia ser zero | Baixa | Mínimo de 60 s |

Em aberto (próximas versões): teto **acumulado** por dia por credencial (hoje é por operação) e janela
deslizante no disjuntor (hoje é fixa: no virar da janela dá para sair ~2× o teto em pouco tempo).
