# Regras de negócio — Financeiro

## Balanço / fórmulas
- REGRA: Balanço inicial = vendas (comandas+vendas) + títulos financeiros + comissão + compras.
- REGRA: valor central do balanço = previsto - realizado (ex.: 345-0=345; 138.581,50-58.760,78=79.820,72). Previsto bate com filtro "Total" de Contas a Receber; realizado com filtro "Recebidos".
- REGRA: despesas do balanço batem com "Despesas realizadas" (realizado)/"em aberto" (previsto) no Extrato de Movimentação, por Tipo de título.
- REGRA: Visão geral — Receitas=status "Recebido"; Despesas=status "Pago"; A Receber=status "Em aberto"/"Em atraso"/"A receber"; A Pagar=status "Em aberto"/"Em atraso". Cada número abre o relatório filtrado correspondente.

## Contas a Receber / Contas a Pagar
- REGRA: ambos regime de CAIXA; listam parcelas de títulos e/ou vendas/despesas. Receber: tipos = vendas, comandas, títulos de receita. Pagar: tipos = contas a pagar, comissão, compra de estoque.
- REGRA: filtro de período usa data conforme status: "Em aberto"/"Em atraso"→VENCIMENTO; "Recebido"/pago→RECEBIMENTO/PAGAMENTO efetivo; "A receber"→PAGAMENTO do cliente (config "Fluxo" do método≠Imediato, ainda não recebemos).
- REGRA: status "Em aberto"/"Em atraso"/"A receber" mostram relógio amarelo na coluna Recebimento = data é previsão, não fato consumado.
- REGRA: Contas a Pagar compartilha as ações em lote e regras de Contas a Receber (abaixo).

## Ações em lote (Receber e Pagar)
- Operações: Informar pagamento, Desfazer pagamento, Informar recebimento, Editar vencimento, Alterar conta financeira. Falha de validação = PULA a parcela e segue (nunca aborta o lote).
- REGRA Informar pagamento: já paga→pula. Método≠dinheiro→paga na data selecionada, sem outra validação. Dinheiro sem controle de caixa→exige só conta caixa/cofre. Dinheiro COM controle de caixa ativo→exige caixa aberto E ser o MESMO vinculado à parcela; se divergir, pula.
- REGRA Desfazer pagamento: só age se já estiver paga.
- REGRA Informar recebimento: só aplica se já paga pelo cliente e ainda não recebida (status "A receber").
- REGRA Editar vencimento: só permite se NÃO paga (receber) ou NÃO paga por nós (pagar); senão pula sem alterar. Efeito: vencimento<hoje→"Em atraso"; >=hoje→"Em aberto".
- REGRA Alterar conta financeira: dinheiro sem controle de caixa→exige caixa/cofre, senão pula. Pix/outro≠dinheiro→exige só conta bancária. Dinheiro+controle de caixa ativo→NÃO permite trocar de caixa/cofre (atrelado ao controle, não só ao caixa).

## Recebimento parcial
- REGRA: recebimento parcial ≠ parcelamento; parcelamento correto deve ser cadastrado como parcelas desde o início.
- REGRA: ao baixar parcialmente uma parcela em aberto, o valor pago baixa nela e o SALDO REMANESCENTE vira nova parcela com vencimento no mês seguinte, somada à parcela normal já prevista pra esse mês (ex.: parcela R$300 paga R$150 → mês seguinte tem R$300 normal + R$150 do saldo parcial).

## Regime de Caixa x Competência
- REGRA Caixa: reconhece quando dinheiro entra/sai de fato (data pagamento/recebimento). Vale pra Contas a Receber/Pagar, Extrato de Movimentação, Fluxo de Caixa.
- REGRA Competência: reconhece quando a transação ocorre — data da venda/comanda ou data de competência do título. Vale pra Relatório de Competência, Relatório de Categorias, DRE (ignoram parcelamento/recebimento futuro).

## Extrato / Fluxo de Caixa
- REGRA: Extrato de Movimentação = regime de caixa, mesmas regras de período de Contas a Receber/Pagar; lista todas operações (vendas, comandas, títulos a pagar/receber, comissão, compras, transferências, suprimento, sangria, saldo inicial).
- REGRA: Fluxo de Caixa (diário/mensal) = mesma base do Extrato, agrupado por dia/mês; permite excluir saldo inicial/transferências (visão operacional), alternar líquido (sem taxas de máquina) vs bruto, incluir/excluir provisionados. Padrão contábil = só operações efetivas; provisionados é exceção mantida pra clientes legados.
- REGRA: Extrato da Conta Bancária só mostra já pago/recebido (Extrato de Movimentação também mostra em aberto). Saldo divergente → checar saldo inicial lançado indevidamente após já ter movimentações (correção certa = criar conta nova e inativar a antiga), checar pagamentos com data futura, comparar cabeçalhos dos dois extratos.

## Categorias / DRE
- REGRA: categoria serve pra receita OU despesa (credora/devedora), plano de contas contábil. Com DRE habilitada, categoria pode ter "Associação a DRE" (a que seção pertence). Títulos/vendas sempre vinculam categoria FILHA, nunca a pai/principal.
- REGRA: Relatório de Categorias = regime de competência, valores BRUTOS (antes de impostos). Tarifa de máquina de cartão aparece na categoria das preferências, calculada pela DATA DE PAGAMENTO (fato gerador), mesmo com recebimentos futuros em meses seguintes.
- REGRA DRE: requer habilitação nas preferências; guiada pela categoria de toda transação. Desconto/tarifas de recebimento usam categoria das preferências e só aparecem na DRE se ela tiver Associação a DRE. Visão SINTÉTICA — várias categorias podem agrupar na mesma seção. Obrigatória no Brasil (Lei 11.638/07).
- REGRA DRE: baseada no Relatório de Competência; custos por data da venda, conforme cadastro do procedimento/estoque.

## Conciliação Bancária
- REGRA: exige habilitação nas preferências + conta com agência/número preenchidos.
- REGRA OFX: <BANKID>=código do banco (não validado se "Outro"); <BRANCHID>=agência (opcional, ausência não bloqueia); <ACCTID>=conta (obrigatório, se vier agência+conta juntas o sistema concatena e compara com o cadastro).
- REGRA: Itaú/Santander têm tratamento especial (tags do OFX não fecham); banco novo com o mesmo problema exige ticket com OFX de exemplo. Mesmo OFX só importa UMA VEZ (anti-duplicação).
- REGRA 3 formas de conciliar: Sugestão=busca parcela mesma conta/valor/data recebimento OFX ainda não conciliada, usa o PRIMEIRO resultado; Criar nova movimentação=gera título do OFX (entrada→cria PACIENTE; saída→cria FORNECEDOR); Buscar existente=lista parcelas conforme direção (entrada/saída) do OFX.
- REGRA: dá pra ignorar uma operação, mas precisa conciliar/ignorar pro fechamento bater com o extrato.

## Métodos de pagamento
- Receb.x pagto: Boleto/Carteira digital/Cheque/Meta Pay/NuPay/Permuta/PicPay/Pix=ambos. Cartão crédito/débito/Débito automático=só pagto. Link de pagamento/Máquina de cartão/Outros=só receb.
- REGRA conceitual: "cartão crédito/débito"=cartão da PRÓPRIA clínica pra comprar/pagar; "Máquina de cartão"=terminal pra RECEBER do paciente — não confundir.
- REGRA config "Fluxo" (quando o valor pago pelo cliente é efetivamente recebido), 3 grupos: "Imediato"=pagamento e recebimento no mesmo instante (ex.: dinheiro). "X dias"=recebimento X dias após o pagamento, como valor único mesmo se parcelado (ex.: boleto compensa em 2 dias; crédito 3x mas recebido de uma vez em 30 dias). "No fluxo"=paga em N vezes→recebe em N vezes (ex.: 3x→30/60/90 dias). Em ambos, se cair fim de semana empurra pro próximo dia útil.

## Abertura e Fechamento de Caixa
- REGRA: habilita nas preferências; ao ativar cria automaticamente caixa "Caixinha" e um cofre. "Caixa"=local físico do dinheiro; "controle de abertura/fechamento"=registro/acompanhamento das movimentações da gaveta num período (turno/dia), garantindo exatidão de saldo.
- REGRA: ao abrir caixa, o usuário fica responsável pelas operações do dia nele; nenhum outro profissional recebe nesse mesmo caixa — cada operador precisa do próprio caixa. Caixa aberto→todo recebimento em dinheiro fica vinculado ao seu controle.
- REGRA: saldo físico≠sistema → analisar causa (despesa não lançada ou cobrança maior que recebida); se não achar, lançar SANGRIA da diferença pra fechar. Reabertura só para CORREÇÃO de lançamento, nunca pra operacionalizar valores novos do dia a dia.
- REGRA (invariante): REFECHAMENTO deve ser SEMPRE IGUAL ao fechamento original, mesmo após correções internas.

## Preferências do sistema e efeitos
- "Ocultar dados financeiros": esconde valores, toggle "olho" pra exibir sob demanda.
- "Usar DRE": habilita DRE no menu lateral; visão retroativa se categorias vinculadas corretamente.
- "Usar abertura de caixa": ativa validações de caixa-aberto ↔ parcela (Informar pagamento/Alterar conta).
- "Mostrar apenas Dinheiro no caixa": outros métodos continuam vinculados ao caixa internamente, só não aparecem na tela.
- "Conciliação bancária": precisa estar ativa pra função de conciliação aparecer na conta.
- "Categoria de receitas": padrão da comanda automática (agenda) e pré-preenchida em entradas.
- "Método/Conta de receitas/despesas": preenchem automaticamente campos ao criar título.
- "Categoria de transferências/comissões/sangria/suprimento": simplificam cadastro e alimentam a DRE.
- "Categoria de taxas de máquina": onde tarifas aparecem na DRE e no Relatório de Categorias.
- "Categoria de descontos": onde descontos de vendas/parcelas aparecem na DRE.
