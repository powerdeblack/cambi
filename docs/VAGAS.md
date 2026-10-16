# Vagas da cambI (plano de equipe)

Os "especialistas" do painel (docs/PAINEL-ESPECIALISTAS.md) são análises feitas por IA: ajudam a pensar, mas não
assinam parecer, não têm registro profissional e podem errar citações. As funções abaixo precisam de **pessoas reais**,
e algumas exigem **registro profissional** (OAB, CRC, certificações). Faixas de remuneração são estimativas de mercado
para referência, não pesquisa salarial: confirmar antes de publicar.

## Ordem de contratação

| # | Quando | Função | Formato | Por que agora |
|---|---|---|---|---|
| 1 | Já | **Cofundador(a) técnico(a) (Solana/Rust + TypeScript)** | Sócio(a), equity | O programa, o app e a infraestrutura são o produto. Ninguém de fora assume isso por salário de início |
| 2 | Já | **Advogado(a) regulatório (BCB/CVM)** | Escritório, por projeto | Parecer sobre a Rende (CVM), enquadramento como prestadora de ativos virtuais e contrato com o parceiro. Exige OAB |
| 3 | Já | **Business developer: parceiro autorizado e Baleias** | Sócio(a) ou comissão + equity | Sem parceiro regulado não há piloto; sem Baleias não há liquidez |
| 4 | Piloto | **Head de Compliance / PLD-FT** | Consultor(a) parcial → CLT | Programa de PLD, regras de monitoramento, COAF via parceiro, KYB das Baleias |
| 5 | Antes da mainnet | **Auditoria externa de smart contract** | Empresa especializada, por projeto | A auditoria interna não substitui; parceiro e investidores vão pedir |
| 6 | Piloto | **Designer de produto (UI/UX)** | Freelancer → parcial | Funil, onboarding, acessibilidade (achados do painel de UI/UX) |
| 7 | Piloto | **Growth e conteúdo** | Freelancer | Plano de 30 dias, lista de espera de freelancers e PMEs |
| 8 | Piloto | **Contabilidade e BPO financeiro** | Escritório | Abertura, tributos, IOF com o parceiro. Exige CRC |
| 9 | Piloto | **Encarregado(a) de dados (DPO)** | Terceirizado | LGPD: relatório de impacto, política de dados, canal do titular |
| 10 | Pós-piloto | **Engenheiro(a) de dados** | CLT/PJ | Indexador on-chain, métricas, alertas de compliance |

## Descrições prontas para publicar

### 1. Cofundador(a) técnico(a), Solana e TypeScript
**Sobre:** a cambI é câmbio real↔dólar digital 24 h, com taxa aberta e comprovante público. O cliente troca com um
cofre verificado de provedores (não com estranhos) e pode participar das taxas. Já existe app, programa Anchor com KYC
on-chain, disjuntor, fila de saque e multisig 7 de 10, testados na devnet.
**Você vai:** liderar o programa (Rust/Anchor), o app (React/TypeScript), a infraestrutura e a segurança até a mainnet.
**Precisa ter:** Rust e Anchor em produção; Solana (contas, CPI, compute); TypeScript; testes; noção de segurança de
contratos. **Diferencial:** pagamentos, Pix, oráculos, multisig (Squads).
**Oferta:** equity relevante (a combinar) e vesting de 4 anos com cliff de 1 ano.

### 2. Advogado(a) regulatório (projeto)
**Escopo:** (a) parecer sobre a natureza da Rende (valor mobiliário? fundo? oferta restrita?); (b) enquadramento da
cambI perante as resoluções do BCB sobre ativos virtuais e câmbio; (c) contrato com o parceiro autorizado (quem é o
prestador perante o cliente, CDC, IOF, COAF, regresso); (d) termos de uso e política de privacidade.
**Requisitos:** OAB ativa; experiência com BCB, CVM e ativos virtuais. **Formato:** proposta por escopo.

### 3. Business developer: parceiros e Baleias
**Você vai:** fechar o parceiro autorizado (prestadora de ativos virtuais ou instituição de câmbio) e formar o
consórcio de Baleias (corretoras de câmbio, instituições autorizadas e investidores qualificados).
**Precisa ter:** rede no mercado de câmbio ou de cripto no Brasil; vendas B2B complexas.
**Oferta:** fixo baixo ou comissão + equity.

### 4. Head de Compliance / PLD-FT
**Você vai:** desenhar e operar o programa de PLD-FT do piloto com o parceiro: política de KYC/KYB por nível,
monitoramento (fracionamento, passagem rápida, carteiras novas), fluxo de alerta até o COAF, Travel Rule, sanções e
bloqueio de bens, diligência das Baleias.
**Precisa ter:** experiência em PLD-FT em instituição financeira, de pagamento ou cripto; Circular 3.978; certificação
em PLD é um diferencial. **Formato:** consultoria parcial no piloto.

### 5. Auditoria externa de smart contract (empresa)
**Escopo:** revisão completa do programa `cambi_pool` v2 (KYC, disjuntor, fila, multisig, prova de reserva), testes de
invariantes e relatório público com as correções.
**Critério de escolha:** histórico em Solana/Anchor e relatórios públicos.

### 6. Designer de produto (UI/UX)
**Você vai:** onboarding com objetivo, recebimento do exterior, fluxo de troca e Rende; acessibilidade (contraste AA,
alvos de 44 px); modo escuro; testes de usabilidade com freelancers e turistas.
**Precisa ter:** portfólio de app financeiro mobile; Figma; noção de React é um diferencial.

### 7. Growth e conteúdo
**Você vai:** executar o plano de 30 dias (página para freelancers, posts sem jargão e sem promessa de rendimento,
comunidades, LinkedIn para PMEs) e medir lista de espera, demos e conversas.
**Precisa ter:** experiência com fintech; cuidado com comunicação regulada.

### 8. Contabilidade e BPO financeiro
**Escopo:** abertura e enquadramento da empresa, tributos (IOF com o parceiro, ISS, IRPJ), folha, relatórios para
investidores. **Requisito:** CRC ativo.

### 9. Encarregado(a) de dados (DPO)
**Escopo:** relatório de impacto, política de dados (nada pessoal na blockchain; mapa código↔pessoa só com o parceiro),
prazos de guarda, canal do titular, contratos de controlador e operador.

### 10. Engenheiro(a) de dados
**Você vai:** indexador dos eventos on-chain, métricas (carteiras ativas na semana, saúde do pool), alertas de
compliance pseudonimizados para o parceiro, separação LGPD entre app e blockchain.
**Precisa ter:** TypeScript ou Python, SQL/DuckDB; Solana é um diferencial.

## Onde publicar (custo baixo)

- LinkedIn (vagas e posts do fundador), comunidades Solana Brasil e Superteam, grupos de Rust e de fintech.
- Hackathons e o ecossistema Colosseum (cofundador técnico).
- Indicação de escritórios e consultorias para jurídico, compliance, contabilidade e DPO.
- Para equity: acordo de sócios com vesting, escrito com advogado.
