# Regras de negócio — Cashback / Saldo

## Modelo de dados (PersonBalance / PersonBalanceOperation)
- REGRA: `PersonBalance` guarda totais por paciente: `cashback_amount` (total cashback), `credit_amount` (total saldo), `amount` = soma dos dois.
- REGRA: `PersonBalanceOperation` registra cada operação (`balance_type`=`credit`|`cashback`). Tipos: ORDER(+)=geração/compra, USAGE(-)=uso, REFUND(+)=reembolso, CONVERTION(+)=cashback→saldo ou pacote→saldo, REVERSAL(-)=edição de Order crédito, EXPIRED(-)=expiração, DELETE(-)=cashback deletado ao desativar config, TRANSFER(-)=cashback→saldo ao desativar config.
- REGRA: coluna `cashback_expiration` (nullable) = data de validade, calculada só na geração (config da clínica + data da venda).
- REGRA: coluna `parent_operation_id` liga operação de USO à operação de GERAÇÃO que a originou — controle de vencimento por geração (FIFO por vencimento).
- REGRA: geração de cashback = 1 operação por origem/item. Uso de cashback = 1 operação de uso PARA CADA geração consumida (múltiplas linhas numa mesma venda/parcela), respeitando o que vence primeiro. Uso de saldo NÃO vincula gerações — sempre 1 linha única de uso (status ativo).
- REGRA: listagem de movimentações agrupa múltiplas operações de USO de cashback da mesma venda/parcela numa linha com valor total (considera também data de criação).
- REGRA: job diário roda às 04h verificando cashbacks a expirar.

## Geração de saldo
- REGRA: saldo é gerado por (conforme configuração da clínica): (a) venda de crédito — no momento da venda OU ao informar pagamento (uma das duas, conforme config); (b) transformar item de pacote em saldo; (c) ao desabilitar cashback, se a clínica optar por "transformar em saldo".

## Geração de cashback
- REGRA: exige habilitar configuração nas preferências da clínica (`generate_sales_cashback`). Uma vez habilitado, QUALQUER venda (personalizada, pacote, crédito) gera cashback.
- REGRA: config do valor de cashback pode ser em R$ ou % (estrutura `{type, percentage, amount}`), em dois níveis: (1) Global — preferências da clínica (`default_cashback_stock_item_value`, `default_cashback_consultation_item_value`, `default_cashback_credit_sale_value`, um valor padrão POR TIPO: produto/estoque, procedimento/consulta, venda de crédito); (2) Específico — direto no procedimento ou no item de estoque. O valor específico SEMPRE SUPERA o global quando definido (ex.: global 2%, procedimento "Botox" 5% → aplica 5%).
- REGRA: cashback é calculado POR ITEM/PRODUTO/PROCEDIMENTO da venda, não por venda inteira (ex.: comissão padrão R$25 aplicada a cada um dos 3 itens = R$75 total, não R$25).
- REGRA: se a venda tem desconto, o desconto é diluído proporcionalmente entre os itens (regra de 3) ANTES de calcular o cashback percentual — necessário para % correta. Fórmula: item_ajustado = item_valor * (1 - desconto_total/soma_total_itens). Cashback do item = item_ajustado * percentual (ou valor fixo se configurado em R$).
  - Exemplo sem desconto: Item1=200 (2%)=4 + Item2=150 (R$10 fixo)=10 + Item3=300 (5% global)=15 → total 29.
  - Exemplo com desconto de 50 em 650 total: Item1_ajust=184,62→3,69; Item2=10 (fixo, não sofre proporcionalização de %); Item3_ajust=276,92→13,85 → total 27,54.
- REGRA: comanda gera cashback ao FINALIZAR a comanda.
- REGRA: cashback gerado numa venda NÃO pode ser usado para pagar a PRÓPRIA venda que o originou; pode ser usado em outra venda ou para informar pagamento de outra parcela.
- REGRA (atualização de venda): editar uma venda NUNCA cria cashback novo, mesmo que a config tenha sido habilitada depois da criação da venda — só atualiza operação de cashback já existente, se aplicável. Se a config estava desabilitada na criação e foi habilitada depois, editar a venda não gera cashback.
- REGRA: cashback do título da venda é fixado na CRIAÇÃO da venda; alterações feitas em "informar recebimento" (ex.: desconto adicional no recebimento) NÃO recalculam o cashback. Só desconto aplicado na criação da venda (item ou venda) afeta o valor do cashback.
- REGRA: se o cashback de uma venda já foi UTILIZADO, a venda que o originou NÃO pode ser deletada.

## Ordem de consumo (cashback antes de saldo)
- REGRA CENTRAL: se o paciente tem valores de saldo E cashback, o sistema SEMPRE consome cashback PRIMEIRO, e só depois o saldo.
- REGRA: disponibilidade de uso é a mesma para saldo e cashback: Venda, Venda personalizável, Pagamento, Pagamento personalizável.
- REGRA: em todo cenário de uso deve-se validar se o paciente TEM saldo/cashback suficiente para consumir.
- REGRA (atualização de valor usado — casos de teste):
  - Caso 1: criado com 50 cashback + 50 saldo (só tinha 50 em cashback). Atualizar para 150 de saldo → verificar se há MAIS cashback disponível: se sim, cria nova(s) operação(ões) de uso de cashback; se não (ou insuficiente), atualiza a operação de uso de saldo já criada.
  - Caso 2: criado com 100 cashback. Atualizar para 150 saldo → verificar se ainda há cashback em aberto (parcial da criação): se a operação de criação tem saldo em aberto, atualiza-a; se tem cashback mas sem operação parcial aberta, cria nova operação (ATENÇÃO: `created_at` da nova operação deve ser IGUAL ao da criação original, para permitir agrupamento na listagem); se não há mais cashback, cria operação de uso de saldo.
  - Caso 3: criado com 100 saldo. Atualizar para 150 saldo → se há 50 de cashback, cria operações de cashback; se há só parte em cashback, cria operações de cashback E atualiza a operação de saldo; se não há cashback, apenas atualiza o valor da operação de saldo.
  - Caso 4: criado com 50 cashback + 50 saldo. Alterar para 25 → cancela os 50 de saldo; cancela e/ou atualiza operações de cashback respeitando vencimento até fechar 25. (OBS: se alterasse para 75, só atualizaria a operação de saldo; se alterasse para 50, só cancelaria a operação de saldo.)
  - Caso 5: criado com 100 cashback. Alterar para 50 → cancela e/ou atualiza operações de cashback respeitando vencimento até fechar 50.
  - Caso 6: criado com 100 saldo. Alterar para 50 → apenas atualiza o valor da operação de saldo.

## Expiração / Validade
- REGRA: validade do cashback é definida nas preferências da clínica (`cashback_expiration`, em dias). Valor 0 = SEM validade, cashback nunca expira.
- REGRA: data de validade é calculada com base na DATA DA VENDA + dias configurados (ex.: config=90 dias, venda em D → validade = D+90).
- REGRA: alterar a config de validade da clínica NÃO se aplica retroativamente aos cashbacks JÁ GERADOS (só afeta gerações futuras).
- REGRA: ao vencer, gera-se operação "Cashback expirado" pelo SALDO REMANESCENTE daquela geração específica (não pelo total gerado originalmente). Exemplo: gerou 50, usou 25 antes de vencer → expira só 25 (o restante).
- REGRA: se um cashback de 100 tem 50 já usados e os 50 restantes vencem, a operação "Cashback expirado" é feita só para os 50 restantes, nunca para os 100 originais.
- REGRA: verificação de expiração roda diariamente às 04h (job `CheckCashbackExpiration`).

## Estornos / Cancelamentos / Desabilitação de cashback
- REGRA (REVERSAL): ao editar uma Order do tipo crédito, gera operação de reversão (direção -).
- REGRA (DELETE): se a clínica desativa a configuração de cashback, cashbacks ainda pendentes de uso podem ser deletados (operação DELETE, -) — uma das duas opções abaixo.
- REGRA (TRANSFER/CONVERTION): ao desabilitar cashback, a clínica escolhe entre (a) TRANSFORMAR o cashback ainda não utilizado em SALDO (operação TRANSFER, - no cashback / CONVERTION, + no saldo) ou (b) EXCLUIR os cashbacks pendentes (DELETE).
- REGRA: se o cashback de uma venda já foi usado, a venda de origem não pode ser deletada (ver seção Geração de cashback).

## Configurações da clínica e efeitos
- REGRA `generate_sales_cashback` (bool): liga/desliga geração de cashback em vendas.
- REGRA `default_cashback_stock_item_value`, `default_cashback_consultation_item_value`, `default_cashback_credit_sale_value`: valores padrão globais de cashback, SEPARADOS por tipo (produto/estoque, procedimento/consulta, venda de crédito), cada um com estrutura `{type: percentage|amount, percentage, amount}`. Só usados quando o item/procedimento específico NÃO tem valor próprio definido.
- REGRA `cashback_expiration` (int, dias): validade global do cashback; 0 = nunca expira.
- REGRA: itens de estoque podem ter valor de cashback próprio ao habilitar o item para venda (supera o global).
- REGRA: procedimentos podem ter valor de cashback próprio cadastrado (supera o global).
- REGRA: quem define o valor de cashback (R$ ou %) é a clínica — sistema NÃO valida se o cashback é maior que o preço do item (ex.: item R$5,99 com padrão R$25; decisão de negócio, sistema não bloqueia).

## Casos de teste de referência
- Config "usar cashback" on/off; mesclagem de pacientes com cashback; todos tipos de venda; uso de saldo ao informar pagamento e desfazer.
