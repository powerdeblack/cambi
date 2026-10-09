# Conformidade: normas brasileiras e internacionais

Como a cambI se comporta **como se fosse operar de verdade**, o que já está no app (versão de hackathon) e o que
falta para produção.

> **Aviso:** este é um mapa de produto, feito por quem constrói o app, e não um parecer jurídico. Antes de operar com
> dinheiro real, cada item passa por revisão de advogado e do parceiro regulado. Alíquotas e prazos mudam; os números
> estão marcados como "de referência" no app.

## Modelo regulatório

A cambI não pretende ser instituição financeira por conta própria. O desenho é **"descentralizado por dentro,
regulado na porta"**:

- O **pool** (troca, divisão de taxas, Rende e Baleia) é um programa na Solana, auditável por qualquer pessoa.
- A **entrada e a saída** (Pix em reais, conta nos EUA, cartão) passam por **parceiros autorizados**. O principal é
  uma prestadora de serviços de ativos virtuais (**SPSAV**) autorizada pelo Banco Central, responsável pelo cadastro,
  pelo câmbio e pelas comunicações aos órgãos.

## Brasil

| Norma | O que exige | No app (hackathon) | Para produção |
|---|---|---|---|
| **Lei 14.478/2022** (marco dos criptoativos) e **Res. BCB 519, 520 e 521** (em vigor desde 2/2/2026) | Prestadora de ativos virtuais autorizada; troca de stablecoin tratada como câmbio | Parceiro "autorizado" simulado; avisos em Informações regulatórias | Contrato com SPSAV autorizada, ou pedido de autorização |
| **Lei 14.286/2021** (marco cambial) e **Res. BCB 277/2022** | Identificação do cliente e da **finalidade** de cada operação; informar o custo total | **Finalidade obrigatória** em toda troca; **VET** mostrado antes de confirmar | Classificação oficial da natureza da operação e registro pelo parceiro |
| **Decreto 6.306/2007** (IOF), com as mudanças de 2025 | IOF sobre operações de câmbio | **IOF estimado** na troca e no simulador (3,5% na compra e 0,38% na venda, de referência) | Alíquota vigente, recolhida pelo parceiro |
| **Lei 9.613/1998** e **Circular BCB 3.978/2020** (PLD/FT) | Cadastro (KYC), avaliação de risco, **PEP**, origem dos recursos, monitoramento, comunicação ao COAF | **Verificação de identidade**: nome, **CPF validado**, maioridade, PEP, origem dos recursos e declaração. **Limites**: R$ 1.000 por operação sem verificação, R$ 50.000 verificado | Documento com foto e prova de vida por provedor de KYC, consulta à Receita, listas restritivas, monitoramento de transações, política de PLD/FT |
| **Res. CVM 30/2021** (perfil do investidor) | Suitability antes de recomendar ou distribuir investimento; investidor qualificado para produtos de risco | **Perfil de investidor** obrigatório antes do 1º depósito na Rende; aviso e ciência se conservador investir em dólar; Baleia descrita como só para qualificados | Enquadramento da Rende e da Baleia como oferta (com assessoria jurídica), termo de adesão, declaração de qualificado |
| **Lei 13.709/2018** (LGPD) | Base legal, transparência, minimização, direitos do titular, encarregado | **Política de privacidade**; aceite ao criar a conta; dados só no aparelho; **baixar meus dados** (portabilidade) e **apagar meus dados**; CPF mascarado; **nada pessoal vai para a blockchain** (só um código de referência) | Encarregado (DPO) nomeado, registro de tratamento, relatório de impacto, contratos com operadores, prazos legais de guarda |
| **Lei 8.078/1990** (CDC) | Informação clara de preço e riscos; termos claros | Termos de uso em linguagem simples; preço, taxa, IOF e VET antes de confirmar; tela de **Riscos** (sem FGC, câmbio oscila, sem auditoria externa) | Revisão jurídica dos textos |
| **Decreto 11.034/2022** (SAC) e regras de **ouvidoria** do Banco Central | Atendimento acessível, ouvidoria com protocolo e prazo | Tela de **Atendimento e ouvidoria**; canais da demo (GitHub) | SAC 24h, ouvidoria, canal no Banco Central e consumidor.gov.br |
| **IN RFB 1.888/2019** (criptoativos) | Prestadoras informam operações com criptoativos à Receita | Citado em Informações regulatórias | Envio feito pelo parceiro |
| **FGC** | Não cobre ativos virtuais nem o pool | Aviso em todos os pontos de investimento | Igual |

## Internacional

| Norma | O que exige | No app (hackathon) | Para produção |
|---|---|---|---|
| **GAFI/FATF, Recomendação 16 (Travel Rule)** | Envios de cripto acima de US$/€ 1.000 levam dados de quem envia e de quem recebe | Envio para carteira a partir de **US$ 1.000** pede: "a carteira é minha" ou o **nome completo de quem recebe** | Troca de dados com a outra prestadora (protocolo de Travel Rule) |
| **Sanções** (ONU, OFAC/EUA e listas adotadas no Brasil) | Não operar com pessoas e endereços sancionados | **Triagem de endereço** antes de enviar; endereço da lista de teste é **bloqueado** | Provedor de análise on-chain e triagem de nomes, atualizado diariamente |
| **FATCA** (EUA) e **CRS** (OCDE) | Identificar residência fiscal (US person e outros países) | Pergunta no cadastro: residente fiscal dos EUA e outro país de residência fiscal | Formulários W-9/W-8 e reportes pelo parceiro |
| **Transferências internacionais (SWIFT)** | Dados de quem envia e de quem recebe (GAFI, Rec. 16, também vale para transferências bancárias); não operar com países sob sanções amplas | "Outro país": nome completo de quem recebe, **IBAN validado** (módulo 97) ou conta, **SWIFT/BIC validado** e conferido com o país; **Cuba, Irã, Coreia do Norte e Síria bloqueados** | Banco correspondente parceiro, triagem de nomes e mensagens SWIFT com os dados completos |
| **EUA: FinCEN/BSA e licenças estaduais** | Envio de dinheiro para os EUA (ACH) | Rota ACH simulada, por "parceiro bancário nos EUA" | Parceiro americano licenciado faz a ponta em dólar |
| **PCI DSS** e regras das bandeiras (Visa/Mastercard) | Segurança de dados de cartão e emissão por emissor licenciado | Não aplicável ainda (o cartão está no roadmap) | Emissor parceiro, cartão vinculado ao saldo em dólar, app sem tocar em dados de cartão |
| **GDPR** (União Europeia) | Proteção de dados de residentes na UE | Mesmas práticas da LGPD (minimização, portabilidade, exclusão) | Avaliar se haverá clientes na UE |

## Onde ver no app

- **Perfil** (ícone de pessoa no topo): verificação de identidade, limite por operação, perfil de investidor, baixar ou
  apagar dados e documentos (Termos, Privacidade, Riscos, Informações regulatórias, Atendimento).
- **Criar conta**: aceite dos Termos e da Política de privacidade.
- **Trocar**: finalidade obrigatória, IOF, VET e limite da conta.
- **Rende**: perfil de investidor antes do primeiro depósito e ciência de inadequação.
- **Enviar para carteira**: triagem de sanções e Travel Rule a partir de US$ 1.000.

## Testes

- `app/src/compliance.test.ts`: CPF (dígitos verificadores, sequências repetidas), maioridade, limites, perfil de
  investidor, Travel Rule e sanções.
- `app/src/taxes.test.ts`: IOF e VET.
- `scripts/ui-e2e.cjs`: o teste das telas na devnet escolhe a finalidade da troca e responde o perfil de investidor
  antes de depositar.
