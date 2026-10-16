# Painel de especialistas (branch v2, 16/10/2026)

Cinco revisões independentes do projeto, cada uma de um ângulo. Análise informativa: o jurídico e o regulatório
**não são parecer** e precisam de revisão por advogado habilitado antes de qualquer lançamento.

## 1. Auditor de smart contracts
8 achados no v2, nenhum crítico. Todos os que dava para fechar sem mudar o desenho foram corrigidos no v2.1
(detalhes em [SEGURANCA-V2.md](SEGURANCA-V2.md#auditoria-interna-do-v2-v21)). Em aberto: teto acumulado por dia por
credencial e janela deslizante no disjuntor.

## 2. Economista de câmbio e tokenomics (simulações próprias, premissas declaradas)
| Gargalo | Número | Correção proposta |
|---|---|---|
| Pool seca no lado do dólar: ao preço do oráculo ninguém ganha reequilibrando | 65% do fluxo comprando dólar → dólar acaba no dia ~16 | Desconto de preço para quem reequilibra (k ≈ 2%: não secou em 30 dias, custo ~5% das taxas dos LPs) e taxa pelo desequilíbrio médio antes/depois da troca |
| Arbitragem contra oráculo lento | Oráculo de hora em hora: perda ~12% do pool ao ano (quase toda a receita dos LPs); por desvio de 0,1%: ~0 | Atualizar por desvio com batida ≤ 60 s, cotação válida ≤ 120 s, regras mais duras fora do pregão, recusar se as fontes divergirem > 0,3% |
| Risco cambial sem dono | Alta de 5% com R$ 8 mi trocados = rombo de R$ 400 mil | Contabilidade por valor patrimonial (Baleia fica com o resíduo) e teto de posição aberta = 1,5× capital das Baleias |
| Custo de oportunidade e diluição | LPs precisam girar ≥ 6,3% do pool por dia só para empatar com CDI/T-bill | Teto de capacidade + fila de entrada; carência ≥ 24 h; lastro que rende |
| Taxa de varejo | Na prática 1,2–1,5% para quem compra dólar | 0,6–0,8% no varejo; desconto de depositante só com ≥ R$ 1.000 por 30 dias |

Na devnet o oráculo roda num agendador do GitHub (cotação válida por 24 h): serve para demonstração, **não** para
dinheiro real. Isso fica explícito.

## 3. Regulatório (BCB, CVM, IOF, LGPD)
1. A cambI provavelmente é **prestadora de serviços de ativos virtuais**: exige autorização do BCB (capital mínimo
   informado de R$ 10,8 a 37,2 mi). Caminho rápido: ser a tecnologia de uma prestadora autorizada ou em processo.
2. A **Rende** tende a ser oferta de valor mobiliário (Parecer CVM 40): começar só com investidor qualificado ou
   estruturar como fundo.
3. Troca com stablecoin é **operação de câmbio** (Res. BCB 521): Baleias precisam ser instituições autorizadas.
4. Pagar QR Pix com dólar digital: o lojista recebe **reais** do parceiro; Solana Pay só para quem recebe de fora.
5. IOF incerto: alíquota parametrizável e modelo que feche no pior cenário.

## 4. Jurista constitucional (ênfase em STF)
- **Competência do BCB**: base forte (ADI 6696, autonomia do BCB; Leis 14.286 e 14.478). Não apostar em contestar a
  Res. 521; cumprir via parceiro.
- **IOF por decreto** (ADC 96 e ADIs 7827/7839, 2025): aumentar alíquota tende a ser válido; criar fato gerador novo
  por decreto é atacável.
- **Dados** (ADIs 6387–6393, EC 115/2022, Tema 990): nada pessoal on-chain é o desenho certo; apagar o mapa
  código↔pessoa equivale à eliminação; COAF só por canal formal.
- **Curso forçado do real**: o lojista recebe em reais.
- **CDC** (Súmulas 297 e 479 do STJ; REsp 2.104.122): responsabilidade objetiva e solidária com o parceiro.
- **Penal** (Lei 7.492/86, art. 16 e 22; CP art. 171-A): o ponto mais sensível é captar do varejo com promessa de
  rendimento; membros da multisig podem ser vistos como gestores de fato.

**3 decisões a tomar agora:** enquadramento da Rende (com parecer), contrato com o parceiro do BCB (quem é o
prestador, CDC, IOF, COAF, regresso) e política de dados formal (RIPD, prazos de guarda, protocolo SISCOAF).

## 5. Produto e growth
Funil: falta "Adicionar via Pix" e "Receber do exterior"; criar conta usa jargão de cripto; nada traz a pessoa de
volta; **nenhuma medição**. Já aplicado no v2: compartilhar a economia no recibo e depósito na Rende que segue
sozinho depois do questionário de perfil.

North star: carteiras ativas na semana (pelo menos 1 troca ou pagamento em 7 dias). Plano de 30 dias com 5
experimentos (landing para freelancers, compartilhar economia, piloto com PMEs exportadoras, conteúdo "dono do
câmbio", turistas pagando QR Pix), medição sem dado pessoal (LGPD).

## O que vem a seguir (ordem sugerida)
1. Programa v2.1 na devnet + teste de ecossistema com relatório medido.
2. Oráculo por desvio (pelo menos fora do agendador do GitHub) e desconto para quem reequilibra.
3. "Receber do exterior" (freelancer) e "Adicionar via Pix" (simulado) no app; medição sem dado pessoal.
4. Rende só para investidor qualificado até haver parecer; contrato-modelo com parceiro autorizado.

## Segunda rodada: compliance, marketing, UI/UX, arquitetura de dados e ciência de dados

| Especialista | Principal achado | Aplicado no v2 |
|---|---|---|
| Compliance PLD-FT | Bens de sancionado precisam ser **bloqueados** (Lei 13.810), inclusive saque; Baleia só institucional; tetos por titular, não por carteira; 11 regras de monitoramento | `set_frozen` (trava troca, depósito e saque), depósito na Baleia só nível 3, teto diário por credencial. Pendente: teto por titular (hash do CPF com o parceiro), envio externo pelo programa, motor de regras |
| Marketing | Posicionamento: taxa aberta, sem estranho do outro lado, dólar útil; tirar promessa de rendimento e jargão | Textos do app revisados (Home, Trocar, Rende, QR); "Receber do exterior" |
| UI/UX | Faixa "Baleia" sem cor (conflito de CSS), contraste dos botões verdes abaixo de AA, botão desabilitado sem motivo, erro técnico em inglês | Corrigidos; alvos de toque maiores; aviso de finalidade e de declaração |
| Arquitetura de dados | Indexador barato em GitHub Actions, transações com erro também (disjuntor e limites não emitem evento), separação LGPD em 3 zonas | Plano registrado; indexador é o próximo passo |
| Ciência de dados | Disjuntor de 30% é bom; janela fixa deixa sair 44%; o desconto para quem reequilibra reduz recusas ~10× num dia de estresse; A/B de taxa precisa de ~470 carteiras por braço para detectar 8 p.p. | Janela deslizante e desconto k = 2% no programa v2.4 (ida e volta sem lucro, testado) |

Plano de equipe com pessoas reais (e o que exige registro profissional): [VAGAS.md](VAGAS.md).
