# Modelo econômico

> Simulações com premissas declaradas. **Não são promessa de rendimento.** Valores antes de IR e IOF.

## Premissas

| Item | Valor | Fonte |
|---|---|---|
| CDI | 13,65% a.a. (estimativa) | Selic em 13,75% após o Copom de 16/09/2026 |
| Tesouro americano (3 meses) | 3,86% a.a. | T-bill, semana de 28/08/2026 (FRED) |
| Pool | R$ 100 milhões, 50% real / 50% dólar | Hipótese |
| Camadas | Rende 90% do pool (5% líquido) · Baleia 10% (100% líquida) | Calibrado em `sim/cambi_sim.py` |
| Mix de volume | 60% apps parceiros (B2B), 20% depositantes, 20% varejo | Hipótese a validar |
| Taxas | B2B 0,4% · depositante 0,5% · varejo 1,0% | Proposta |
| Custo do parceiro regulado | 0,2% do volume que passa pelo Pix | Estimativa |
| Perda por desequilíbrio | 0,1% do volume (absorvida pela Baleia) | Estimativa |
| Divisão | 25% cambI · do restante, 70% Baleia / 30% Rende | Proposta |
| Performance | cambI fica com 20% do que a Rende ganhar acima de 100% do CDI | Proposta |

"Giro" = volume diário de trocas ÷ tamanho do pool.

## Resultados

| Giro diário | Rende em reais | Rende em dólar | Baleia | Receita cambI/ano |
|---|---|---|---|---|
| 2% | 13,8% (101% do CDI) | 4,4% (1,1× T-bill) | 12,1% | R$ 0,86 mi |
| 3% | 14,1% (103% do CDI) | 4,7% (1,2×) | 17,2% | R$ 1,35 mi |
| **5%** | **14,8% (108% do CDI)** | **5,4% (1,4×)** | **27,4%** | **R$ 2,33 mi** |
| 8% | 15,8% (116% do CDI) | 6,4% (1,6×) | 42,6% | R$ 3,81 mi |

## Custo para quem troca R$ 5.000 (sem IOF)

| Onde | Custo |
|---|---|
| Banco (~5,5%) | R$ 275 |
| Casa de câmbio (~3,8%) | R$ 190 |
| Conta global (~1,5%) | R$ 75 |
| cambI, varejo (1%) | R$ 50 |
| cambI, depositante (0,5%) | R$ 25 |

## Por que duas camadas

Uma versão com camada única exigia deixar 30–50% do dinheiro parado para atender as trocas. Com o CDI alto,
isso fazia o depositante em reais render **abaixo** de uma conta comum quando o movimento era baixo.
Separando em **Rende** (quase tudo aplicado, protegida) e **Baleia** (motor de liquidez, assume o risco e recebe
mais), cada perfil recebe o que procura, e a reserva necessária cai para 10–15% do pool.

## O que decide se o modelo funciona

1. **Volume B2B.** Abaixo de ~2% de giro diário, a Rende só empata com o CDI. O volume vem de apps de pagamento com
   stablecoin, remessas e freelancers, não de pessoas físicas trocando de vez em quando.
2. **Escala.** Só com o pool, a operação se sustenta a partir de R$ 100 milhões e vira um negócio sólido perto de
   R$ 500 milhões. Remessas, cartão e API B2B são necessários, não opcionais.
3. **Risco da Baleia.** Os retornos da Baleia remuneram o risco de desequilíbrio; numa crise cambial podem ser negativos.

## Reproduzir

```bash
python3 sim/cambi_sim.py
cd app && npm test   # a projeção em TypeScript é verificada contra estes números
```
