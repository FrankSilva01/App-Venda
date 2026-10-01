// Teste de fumaca dos modulos. `node scripts/smoke.js` com a API no ar.
//
// O que ele prova, nesta ordem:
//   A) com TODOS os modulos desligados o fluxo vai do QR ao fechamento;
//   B) as rotas dos modulos desligados respondem 409, e nao 500 nem 404;
//   C) ligando o pagamento antecipado, o pedido so entra na cozinha depois de pago;
//   D) ligando o estoque simples, o item zera e some do cardapio sozinho.
//
// No fim devolve a configuracao ao padrao e apaga o que criou. Roda contra
// banco com dado dentro sem sujar nada: mesa e produto tem sufixo aleatorio.
const { pool, query } = require('../config/server/dbConnection');

const API = process.env.API || 'http://localhost:' + (process.env.PORT || 3001);
const sufixo = Math.random().toString(36).slice(2, 7);

let falhas = 0;
function ok(nome, condicao, detalhe) {
  console.log((condicao ? '  ok   ' : '  FALHA') + '  ' + nome + (condicao || detalhe === undefined ? '' : '  <- ' + JSON.stringify(detalhe)));
  if (!condicao) falhas++;
}

async function chama(metodo, caminho, corpo) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { dados = null; }
  return { status: r.status, dados };
}

(async () => {
  console.log('API:', API, '\n');

  // ------------------------------------------------------------ preparo
  await chama('PUT', '/api/configuracoes', {
    'pagamento.modo': 'fechamento', 'pagamento.integrado': 'false',
    'estoque.modo': 'desligado', 'financeiro.ativo': 'true',
  });

  const prod = await query(
    `INSERT INTO produtos (nomeProduto, precoProduto, descricaoProduto, quantidadeProduto, categoria)
     VALUES ($1, 30.00, 'item de teste', 2, 'teste') RETURNING idnomeProduto`,
    ['Teste ' + sufixo]
  );
  const produtoId = prod.rows[0].idnomeproduto;

  const numeroMesa = 900 + Math.floor(Math.random() * 99);
  const mesa = await chama('POST', '/api/mesas', { numero: numeroMesa, apelido: 'smoke' });
  ok('cria mesa ' + numeroMesa, mesa.status === 201, mesa.dados);

  // ------------------------------------- A) fluxo padrao, sem modulo nenhum
  console.log('\nA) fluxo padrao (tudo desligado)');

  const card = await chama('GET', '/api/mesa/' + numeroMesa + '/cardapio');
  ok('QR abre o cardapio da mesa', card.status === 200 && card.dados.mesa.numero === numeroMesa);
  ok('cardapio nao oferece pagar agora', card.dados.pagamento.pode_pagar_agora === false, card.dados.pagamento);
  ok('produto de teste aparece',
    card.dados.produtos.some((p) => p.idnomeproduto === produtoId));

  const ped = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, cliente: 'Smoke',
    itens: [{ produto_id: produtoId, quantidade: 1, observacao: 'sem cebola' }],
  });
  ok('pedido criado', ped.status === 201, ped.dados);
  ok('pedido foi DIRETO para a cozinha', ped.dados.na_cozinha === true, ped.dados);
  const comandaId = ped.dados.comanda_id;
  const pedidoId = ped.dados.pedido.id;

  const fila = await chama('GET', '/api/cozinha');
  ok('aparece na fila da cozinha', fila.dados.some((p) => p.id === pedidoId));

  ok('observacao chega na cozinha',
    (fila.dados.find((p) => p.id === pedidoId) || { itens: [] }).itens.some((i) => i.observacao === 'sem cebola'));

  for (const etapa of ['preparo', 'pronto', 'entregue']) {
    const r = await chama('POST', '/api/pedidos/' + pedidoId + '/' + etapa);
    ok('pedido -> ' + etapa, r.status === 200, r.dados);
  }
  const repetido = await chama('POST', '/api/pedidos/' + pedidoId + '/preparo');
  ok('nao volta de etapa (409)', repetido.status === 409, repetido.dados);

  const com = await chama('GET', '/api/comandas/' + comandaId);
  ok('comanda soma consumo + 10% de servico',
    com.dados.totais.consumo === 30 && com.dados.totais.servico === 3 && com.dados.totais.total === 33,
    com.dados.totais);

  const cedo = await chama('POST', '/api/comandas/' + comandaId + '/fechar');
  ok('nao fecha com saldo em aberto (409)', cedo.status === 409, cedo.dados);

  const pg = await chama('POST', '/api/comandas/' + comandaId + '/pagamentos', { forma: 'dinheiro', valor: 33 });
  ok('caixa recebe dinheiro sem o modulo de pagamento', pg.status === 201, pg.dados);
  ok('saldo zerou', pg.dados.totais && pg.dados.totais.saldo === 0, pg.dados.totais);

  const fechou = await chama('POST', '/api/comandas/' + comandaId + '/fechar');
  ok('comanda fecha', fechou.status === 200, fechou.dados);

  // ------------------------------------- B) modulo desligado nao quebra nada
  console.log('\nB) rotas dos modulos desligados');
  const semPag = await chama('POST', '/api/pagamento/pedido/' + pedidoId, { forma: 'pix' });
  ok('pagamento desligado responde 409', semPag.status === 409, semPag.dados);
  const semEst = await chama('GET', '/api/estoque/ingredientes');
  ok('estoque desligado responde 409', semEst.status === 409, semEst.dados);
  const comFin = await chama('GET', '/api/financeiro/resumo');
  ok('financeiro ligado responde o resumo', comFin.status === 200, comFin.dados);

  const incoerente = await chama('PUT', '/api/configuracoes', { 'pagamento.modo': 'antecipado' });
  ok('recusa antecipado sem o modulo de pagamento (400)', incoerente.status === 400, incoerente.dados);

  // ------------------------------------- C) pagamento antecipado
  console.log('\nC) modulo de pagamento, modo antecipado');
  const liga = await chama('PUT', '/api/configuracoes', {
    'pagamento.integrado': 'true', 'pagamento.modo': 'antecipado',
  });
  ok('liga pagamento integrado + antecipado', liga.status === 200, liga.dados);

  const ped2 = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, cliente: 'Smoke', itens: [{ produto_id: produtoId, quantidade: 1 }],
  });
  ok('pedido criado', ped2.status === 201, ped2.dados);
  ok('pedido NAO foi para a cozinha', ped2.dados.na_cozinha === false, ped2.dados);
  const pedido2 = ped2.dados.pedido.id;
  const comanda2 = ped2.dados.comanda_id;

  const fila2 = await chama('GET', '/api/cozinha');
  ok('cozinha nao ve pedido nao pago', !fila2.dados.some((p) => p.id === pedido2));

  const pagou = await chama('POST', '/api/pagamento/pedido/' + pedido2, { forma: 'pix' });
  ok('pagamento aprovado', pagou.status === 201, pagou.dados);
  ok('pagamento liberou a cozinha', pagou.dados.liberou_cozinha === true, pagou.dados);
  ok('Pix sem taxa', Number(pagou.dados.pagamento.taxa) === 0, pagou.dados.pagamento);

  const fila3 = await chama('GET', '/api/cozinha');
  ok('agora aparece na fila', fila3.dados.some((p) => p.id === pedido2));

  const duplicado = await chama('POST', '/api/pagamento/pedido/' + pedido2, { forma: 'pix' });
  ok('nao paga duas vezes (409)', duplicado.status === 409, duplicado.dados);

  // ------------------------------------- D) estoque simples
  console.log('\nD) modulo de estoque, modo simples');
  await chama('PUT', '/api/configuracoes', { 'estoque.modo': 'simples' });

  const antes = await query('SELECT quantidadeProduto, disponivel FROM produtos WHERE idnomeProduto = $1', [produtoId]);
  ok('produto comeca com 2 e disponivel',
    Number(antes.rows[0].quantidadeproduto) === 2 && antes.rows[0].disponivel === true, antes.rows[0]);

  const ped3 = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, cliente: 'Smoke', itens: [{ produto_id: produtoId, quantidade: 2 }],
  });
  ok('pedido de 2 unidades criado', ped3.status === 201, ped3.dados);
  await chama('POST', '/api/pagamento/pedido/' + ped3.dados.pedido.id, { forma: 'cartao_credito' });

  // A baixa roda no evento, fora da requisicao: esperar um instante e nao um
  // valor fixo grande e o suficiente aqui porque e tudo no mesmo processo.
  await new Promise((r) => setTimeout(r, 400));

  const depois = await query('SELECT quantidadeProduto, disponivel FROM produtos WHERE idnomeProduto = $1', [produtoId]);
  ok('estoque baixou para 0', Number(depois.rows[0].quantidadeproduto) === 0, depois.rows[0]);
  ok('produto ficou indisponivel sozinho', depois.rows[0].disponivel === false, depois.rows[0]);

  const card2 = await chama('GET', '/api/mesa/' + numeroMesa + '/cardapio');
  ok('sumiu do cardapio do QR', !card2.dados.produtos.some((p) => p.idnomeproduto === produtoId));

  const recusa = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, cliente: 'Smoke', itens: [{ produto_id: produtoId, quantidade: 1 }],
  });
  ok('nao aceita pedir item indisponivel (409)', recusa.status === 409, recusa.dados);

  const cartao = await chama('GET', '/api/financeiro/formas');
  ok('financeiro separa Pix de cartao',
    cartao.dados.some((f) => f.forma === 'cartao_credito' && Number(f.taxas) > 0), cartao.dados);

  // ------------------------------------------------------------ limpeza
  console.log('\nlimpeza');
  await query('DELETE FROM pagamentos WHERE comanda_id IN (SELECT id FROM comandas WHERE mesa_id = (SELECT id FROM mesas WHERE numero = $1))', [numeroMesa]);
  await query('DELETE FROM comandas WHERE mesa_id = (SELECT id FROM mesas WHERE numero = $1)', [numeroMesa]);
  await query('DELETE FROM mesas WHERE numero = $1', [numeroMesa]);
  await query('DELETE FROM estoque_mov WHERE produto_id = $1', [produtoId]);
  await query('DELETE FROM produtos WHERE idnomeProduto = $1', [produtoId]);

  const volta = await chama('PUT', '/api/configuracoes', {
    'pagamento.modo': 'fechamento', 'pagamento.integrado': 'false',
    'estoque.modo': 'desligado', 'financeiro.ativo': 'true',
  });
  ok('configuracao volta ao padrao', volta.status === 200, volta.dados);

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'tudo passou'));
  await pool.end();
  process.exit(falhas ? 1 : 0);
})().catch(async (e) => {
  console.error('\nerro no teste:', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
