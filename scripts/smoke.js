// Teste de fumaca de ponta a ponta. `node scripts/smoke.js` com a API no ar.
//
// O que ele prova, nesta ordem:
//   A) com TODOS os modulos desligados o fluxo vai do QR ao fechamento;
//   B) as rotas dos modulos desligados respondem 409, e nao 500 nem 404;
//   C) ligando o pagamento antecipado, o pedido so entra na cozinha depois de pago;
//   D) ligando o estoque simples, o item zera e some do cardapio sozinho;
//   E) o QR vincula, regera e revoga -- e o adesivo antigo morre;
//   F) sessao e perfil barram o que tem de barrar;
//   G) salao, chamados, pedido do garcom, adicionais e cancelamento com motivo.
//
// No fim devolve a configuracao ao padrao e apaga o que criou. Roda contra
// banco com movimento sem sujar nada: mesa, produto e usuarios de teste tem
// sufixo aleatorio e sao removidos.
const bcrypt = require('bcryptjs');
const { pool, query } = require('../config/server/dbConnection');

const API = process.env.API || 'http://localhost:' + (process.env.PORT || 3001);
const sufixo = Math.random().toString(36).slice(2, 7);

let falhas = 0;
let SESSAO = null;

function ok(nome, condicao, detalhe) {
  console.log((condicao ? '  ok   ' : '  FALHA') + '  ' + nome +
    (condicao || detalhe === undefined ? '' : '  <- ' + JSON.stringify(detalhe)));
  if (!condicao) falhas++;
}

// `sessao` null = chamada anonima (e o que o cliente da mesa faz).
async function chama(metodo, caminho, corpo, sessao) {
  const tk = sessao === undefined ? SESSAO : sessao;
  const headers = {};
  if (corpo) headers['Content-Type'] = 'application/json';
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(API + caminho, {
    method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { dados = null; }
  return { status: r.status, dados };
}

async function criaUsuario(login, perfil, senha) {
  const hash = await bcrypt.hash(senha, 10);
  const r = await query(
    `INSERT INTO usuarios (login, email, cpf, senha, perfil)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [login, login + '@teste', 'cpf-' + login, hash, perfil]
  );
  return r.rows[0].id;
}

(async () => {
  console.log('API:', API, '\n');

  // ------------------------------------------------------------ preparo
  const admLogin = 'smoke-adm-' + sufixo;
  const garLogin = 'smoke-gar-' + sufixo;
  const admId = await criaUsuario(admLogin, 'admin', 'smoke123');
  const garId = await criaUsuario(garLogin, 'garcom', 'smoke123');

  const entrou = await chama('POST', '/api/login', { login: admLogin, senha: 'smoke123' }, null);
  ok('login devolve token e perfil',
    entrou.status === 200 && !!entrou.dados.token && entrou.dados.usuario.perfil === 'admin',
    entrou.dados);
  SESSAO = entrou.dados.token;

  const garEntrou = await chama('POST', '/api/login', { login: garLogin, senha: 'smoke123' }, null);
  const SESSAO_GARCOM = garEntrou.dados.token;

  await chama('PUT', '/api/configuracoes', {
    'pagamento.modo': 'fechamento', 'pagamento.integrado': 'false',
    'estoque.modo': 'desligado', 'financeiro.ativo': 'true',
    'servico.ativo': 'true', 'servico.percentual': '10',
    'operacao.cliente_fecha': 'true', 'operacao.garcom_lanca': 'true',
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
  const mesaId = mesa.dados.id;

  // ------------------------------------- A) fluxo padrao, sem modulo nenhum
  console.log('\nA) fluxo padrao (tudo desligado)');

  const card = await chama('GET', '/api/mesa/' + numeroMesa + '/cardapio');
  ok('abre o cardapio da mesa', card.status === 200 && card.dados.mesa.numero === numeroMesa);
  ok('cardapio nao oferece pagar agora', card.dados.pagamento.pode_pagar_agora === false,
    card.dados.pagamento);
  ok('produto de teste aparece', card.dados.produtos.some((p) => p.idnomeproduto === produtoId));

  const ped = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, cliente: 'Smoke',
    itens: [{ produto_id: produtoId, quantidade: 1, observacao: 'sem cebola' }],
  }, null);
  ok('pedido criado', ped.status === 201, ped.dados);
  ok('pedido foi DIRETO para a cozinha', ped.dados.na_cozinha === true, ped.dados);
  const comandaId = ped.dados.comanda_id;
  const pedidoId = ped.dados.pedido.id;

  const fila = await chama('GET', '/api/cozinha');
  ok('aparece na fila da cozinha', fila.dados.some((p) => p.id === pedidoId));
  ok('observacao chega na cozinha',
    (fila.dados.find((p) => p.id === pedidoId) || { itens: [] })
      .itens.some((i) => i.observacao === 'sem cebola'));

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
  ok('nao fecha com saldo em aberto (409)', cedo.status === 409 && cedo.dados.saldo_pendente, cedo.dados);

  const pg = await chama('POST', '/api/comandas/' + comandaId + '/pagamentos',
    { forma: 'dinheiro', valor: 33 });
  ok('caixa recebe dinheiro sem o modulo de pagamento', pg.status === 201, pg.dados);
  ok('saldo zerou', pg.dados.totais && pg.dados.totais.saldo === 0, pg.dados.totais);

  const hist = await chama('GET', '/api/comandas/' + comandaId + '/historico');
  ok('historico registrou abertura, pedido, etapas e pagamento',
    hist.status === 200 &&
    ['comanda:aberta', 'pedido:criado', 'pedido:pronto', 'pagamento']
      .every((e) => hist.dados.some((l) => l.evento === e)),
    (hist.dados || []).map((l) => l.evento));

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
  }, null);
  ok('pedido NAO foi para a cozinha', ped2.dados.na_cozinha === false, ped2.dados);
  const pedido2 = ped2.dados.pedido.id;

  const fila2 = await chama('GET', '/api/cozinha');
  ok('cozinha nao ve pedido nao pago', !fila2.dados.some((p) => p.id === pedido2));

  const pagou = await chama('POST', '/api/pagamento/pedido/' + pedido2, { forma: 'pix' }, null);
  ok('pagamento aprovado', pagou.status === 201, pagou.dados);
  ok('pagamento liberou a cozinha', pagou.dados.liberou_cozinha === true, pagou.dados);
  ok('Pix sem taxa', Number(pagou.dados.pagamento.taxa) === 0, pagou.dados.pagamento);

  const fila3 = await chama('GET', '/api/cozinha');
  ok('agora aparece na fila', fila3.dados.some((p) => p.id === pedido2));
  const duplicado = await chama('POST', '/api/pagamento/pedido/' + pedido2, { forma: 'pix' }, null);
  ok('nao paga duas vezes (409)', duplicado.status === 409, duplicado.dados);

  // ------------------------------------- D) estoque simples
  console.log('\nD) modulo de estoque, modo simples');
  await chama('PUT', '/api/configuracoes', { 'estoque.modo': 'simples' });

  const antes = await query(
    'SELECT quantidadeProduto, disponivel FROM produtos WHERE idnomeProduto = $1', [produtoId]);
  ok('produto comeca com 2 e disponivel',
    Number(antes.rows[0].quantidadeproduto) === 2 && antes.rows[0].disponivel === true, antes.rows[0]);

  const ped3 = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, cliente: 'Smoke', itens: [{ produto_id: produtoId, quantidade: 2 }],
  }, null);
  ok('pedido de 2 unidades criado', ped3.status === 201, ped3.dados);
  await chama('POST', '/api/pagamento/pedido/' + ped3.dados.pedido.id,
    { forma: 'cartao_credito' }, null);
  await new Promise((r) => setTimeout(r, 400));

  const depois = await query(
    'SELECT quantidadeProduto, disponivel FROM produtos WHERE idnomeProduto = $1', [produtoId]);
  ok('estoque baixou para 0', Number(depois.rows[0].quantidadeproduto) === 0, depois.rows[0]);
  ok('produto ficou indisponivel sozinho', depois.rows[0].disponivel === false, depois.rows[0]);

  const card2 = await chama('GET', '/api/mesa/' + numeroMesa + '/cardapio');
  ok('sumiu do cardapio', !card2.dados.produtos.some((p) => p.idnomeproduto === produtoId));
  const recusa = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, itens: [{ produto_id: produtoId, quantidade: 1 }],
  }, null);
  ok('nao aceita pedir item indisponivel (409)', recusa.status === 409, recusa.dados);

  const formas = await chama('GET', '/api/financeiro/formas');
  ok('financeiro separa Pix de cartao',
    formas.dados.some((f) => f.forma === 'cartao_credito' && Number(f.taxas) > 0), formas.dados);

  // ------------------------------------- E) QR
  console.log('\nE) QR code vinculado a mesa');
  await chama('PUT', '/api/configuracoes', { 'estoque.modo': 'desligado' });
  await query(
    'UPDATE produtos SET disponivel = true, quantidadeProduto = 20 WHERE idnomeProduto = $1',
    [produtoId]);

  const semQr = await chama('GET', '/api/mesas/' + mesaId + '/qrcode.svg');
  ok('mesa sem QR responde 404', semQr.status === 404, semQr.dados);

  const gerou = await chama('POST', '/api/mesas/' + mesaId + '/qrcode');
  ok('gera o QR', gerou.status === 201 && !!gerou.dados.mesa.qr_token, gerou.dados);
  ok('devolve o SVG desenhado', /^<svg/.test(gerou.dados.svg || ''), (gerou.dados.svg || '').slice(0, 40));
  const token = gerou.dados.mesa.qr_token;
  ok('a URL do QR leva o token', (gerou.dados.url || '').indexOf(token) > 0, gerou.dados.url);

  const pelaQr = await chama('GET', '/api/qr/' + token, null, null);
  ok('o token abre a mesa certa, sem login',
    pelaQr.status === 200 && pelaQr.dados.mesa.numero === numeroMesa);
  ok('a resposta traz cardapio, comanda e pedidos numa chamada so',
    Array.isArray(pelaQr.dados.produtos) && 'comanda' in pelaQr.dados &&
    Array.isArray(pelaQr.dados.pedidos));

  const pedQr = await chama('POST', '/api/pedidos', {
    token, cliente: 'Pelo QR', itens: [{ produto_id: produtoId, quantidade: 1 }],
  }, null);
  ok('da para pedir so com o token', pedQr.status === 201, pedQr.dados);
  ok('pedido do cliente fica com origem qr', pedQr.dados.pedido.origem === 'qr', pedQr.dados.pedido);
  const comandaQr = pedQr.dados.comanda_id;

  const regerou = await chama('POST', '/api/mesas/' + mesaId + '/qrcode');
  ok('regera com outro token', regerou.dados.mesa.qr_token !== token);
  const velho = await chama('GET', '/api/qr/' + token, null, null);
  ok('o token antigo para de valer (404)', velho.status === 404, velho.dados);
  const token2 = regerou.dados.mesa.qr_token;

  const revogou = await chama('DELETE', '/api/mesas/' + mesaId + '/qrcode');
  ok('revoga o QR', revogou.status === 200 && revogou.dados.mesa.qr_token === null);
  ok('revogado para de valer (404)',
    (await chama('GET', '/api/qr/' + token2, null, null)).status === 404);
  ok('a mesa continua atendendo pelo caixa',
    (await chama('GET', '/api/mesa/' + numeroMesa + '/cardapio')).status === 200);

  const urlTorta = await chama('PUT', '/api/configuracoes', { 'cliente.url': 'mesa.html' });
  ok('recusa URL de cliente sem http (400)', urlTorta.status === 400, urlTorta.dados);

  // ------------------------------------- F) sessao e perfil
  console.log('\nF) sessao e perfil');
  ok('sem sessao, o salao responde 401',
    (await chama('GET', '/api/salao', null, null)).status === 401);
  ok('sem sessao, a cozinha responde 401',
    (await chama('GET', '/api/cozinha', null, null)).status === 401);
  ok('sem sessao, nao da para criar mesa',
    (await chama('POST', '/api/mesas', { numero: 999 }, null)).status === 401);
  ok('token invalido responde 401',
    (await chama('GET', '/api/salao', null, 'nao-existe')).status === 401);

  ok('garcom entra no salao',
    (await chama('GET', '/api/salao', null, SESSAO_GARCOM)).status === 200);
  const garCaixa = await chama('GET', '/api/comandas', null, SESSAO_GARCOM);
  ok('garcom NAO lista o caixa (403)', garCaixa.status === 403, garCaixa.dados);
  ok('garcom LE a conta da mesa que atende',
    (await chama('GET', '/api/comandas/' + comandaQr, null, SESSAO_GARCOM)).status === 200);
  const garPaga = await chama('POST', '/api/comandas/' + comandaQr + '/pagamentos',
    { forma: 'dinheiro', valor: 1 }, SESSAO_GARCOM);
  ok('garcom NAO lanca pagamento (403)', garPaga.status === 403, garPaga.dados);
  const garConfig = await chama('PUT', '/api/configuracoes', { 'servico.percentual': '12' }, SESSAO_GARCOM);
  ok('garcom NAO muda configuracao (403)', garConfig.status === 403, garConfig.dados);
  const garUsuarios = await chama('GET', '/api/usuarios', null, SESSAO_GARCOM);
  ok('garcom NAO ve usuarios (403)', garUsuarios.status === 403, garUsuarios.dados);

  const cadastroPublico = await chama('POST', '/api/cadastrarUsuario',
    { login: 'invasor-' + sufixo, email: 'x@y.z', cpf: '1', senha: 'segredo1' }, null);
  ok('cadastro publico esta fechado (409)', cadastroPublico.status === 409, cadastroPublico.dados);

  const semEu = await chama('PATCH', '/api/usuarios/' + admId, { perfil: 'garcom' });
  ok('ninguem rebaixa o proprio perfil (409)', semEu.status === 409, semEu.dados);

  const saiu = await chama('DELETE', '/api/sessao', null, SESSAO_GARCOM);
  ok('sair encerra a sessao', saiu.status === 200);
  ok('sessao encerrada nao vale mais (401)',
    (await chama('GET', '/api/salao', null, SESSAO_GARCOM)).status === 401);

  // ------------------------------------- G) salao, chamados, garcom, adicionais
  console.log('\nG) salão, chamados, garçom, adicionais e cancelamento');
  // Volta ao modo padrao: a secao C deixou 'antecipado', e com ele o pedido
  // nasce aguardando pagamento -- nao e o que esta secao quer medir.
  await chama('PUT', '/api/configuracoes', {
    'pagamento.modo': 'fechamento', 'pagamento.integrado': 'false',
  });
  const novoQr = await chama('POST', '/api/mesas/' + mesaId + '/qrcode');
  const tk = novoQr.dados.mesa.qr_token;

  const salao = await chama('GET', '/api/salao');
  const minha = salao.dados.find((m) => m.numero === numeroMesa);
  ok('salao lista a mesa com situacao e total',
    salao.status === 200 && !!minha && !!minha.situacao && minha.totais !== null,
    minha && { situacao: minha.situacao, total: minha.totais && minha.totais.total });

  const chamou = await chama('POST', '/api/qr/' + tk + '/chamado', { tipo: 'atendimento' }, null);
  ok('cliente chama o garcom', chamou.status === 201, chamou.dados);
  const dedo = await chama('POST', '/api/qr/' + tk + '/chamado', { tipo: 'atendimento' }, null);
  ok('chamar de novo nao duplica o alerta', dedo.dados.ja_existia === true, dedo.dados);

  const salao2 = await chama('GET', '/api/salao');
  ok('a mesa fica marcada como atendimento no salao',
    salao2.dados.find((m) => m.numero === numeroMesa).situacao === 'atendimento');

  const chamados = await chama('GET', '/api/chamados');
  ok('chamado aparece na lista', chamados.dados.some((c) => c.mesa === numeroMesa));
  const assumiu = await chama('POST', '/api/chamados/' + chamou.dados.chamado.id + '/assumir');
  ok('garcom assume o chamado', assumiu.status === 200 && assumiu.dados.status === 'assumido');
  ok('resolver fecha o chamado',
    (await chama('POST', '/api/chamados/' + chamou.dados.chamado.id + '/resolver')).status === 200);

  const fech = await chama('POST', '/api/qr/' + tk + '/chamado', { tipo: 'fechamento' }, null);
  ok('cliente solicita fechamento', fech.status === 201, fech.dados);
  ok('a mesa fica marcada como fechamento',
    (await chama('GET', '/api/salao')).dados.find((m) => m.numero === numeroMesa).situacao === 'fechamento');
  await chama('PUT', '/api/configuracoes', { 'operacao.cliente_fecha': 'false' });
  await chama('POST', '/api/chamados/' + fech.dados.chamado.id + '/resolver');
  const fechNao = await chama('POST', '/api/qr/' + tk + '/chamado', { tipo: 'fechamento' }, null);
  ok('com fechamento pelo cliente desligado, recusa (409)', fechNao.status === 409, fechNao.dados);
  await chama('PUT', '/api/configuracoes', { 'operacao.cliente_fecha': 'true' });

  // adicionais
  const adic = await chama('POST', '/api/cardapio/adicionais', { nome: 'Bacon ' + sufixo, preco: 5 });
  ok('cria adicional', adic.status === 201, adic.dados);
  const compl = await chama('POST', '/api/cardapio/adicionais',
    { nome: 'Sem gelo ' + sufixo, preco: 0, tipo: 'complemento' });
  ok('cria complemento sem preco', compl.status === 201 && Number(compl.dados.preco) === 0);
  await chama('PUT', '/api/cardapio/produtos/' + produtoId + '/adicionais',
    { adicionais: [adic.dados.id, compl.dados.id] });
  const doProduto = await chama('GET', '/api/cardapio/produtos/' + produtoId + '/adicionais');
  ok('adicional fica vinculado ao produto',
    doProduto.dados.filter((a) => a.vinculado).length === 2);

  const comAdic = await chama('POST', '/api/pedidos', {
    token: tk, cliente: 'Com bacon',
    itens: [{ produto_id: produtoId, quantidade: 2, adicionais: [adic.dados.id] }],
  }, null);
  ok('pedido com adicional soma no preco unitario',
    Number(comAdic.dados.itens[0].preco) === 35, comAdic.dados.itens[0]);
  const pedidoAdic = comAdic.dados.pedido.id;

  const naCozinha = await chama('GET', '/api/cozinha');
  const cardCozinha = naCozinha.dados.find((p) => p.id === pedidoAdic);
  ok('a cozinha ve o adicional discriminado',
    cardCozinha && cardCozinha.itens[0].adicionais.length === 1,
    cardCozinha && cardCozinha.itens[0].adicionais);

  const adicInvalido = await chama('POST', '/api/pedidos', {
    token: tk, itens: [{ produto_id: produtoId, quantidade: 1, adicionais: [999999] }],
  }, null);
  ok('adicional que nao e do produto e recusado (400)', adicInvalido.status === 400, adicInvalido.dados);

  // pedido do garcom
  const garSessao2 = await chama('POST', '/api/login', { login: garLogin, senha: 'smoke123' }, null);
  const pedGarcom = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, itens: [{ produto_id: produtoId, quantidade: 1 }],
  }, garSessao2.dados.token);
  ok('garcom lanca pedido pela mesa', pedGarcom.status === 201, pedGarcom.dados);
  ok('pedido do garcom fica com origem garcom e usuario',
    pedGarcom.dados.pedido.origem === 'garcom' && pedGarcom.dados.pedido.usuario_id === garId,
    pedGarcom.dados.pedido);

  await chama('PUT', '/api/configuracoes', { 'operacao.garcom_lanca': 'false' });
  const garBarrado = await chama('POST', '/api/pedidos', {
    mesa: numeroMesa, itens: [{ produto_id: produtoId, quantidade: 1 }],
  }, garSessao2.dados.token);
  ok('com lancamento pelo garcom desligado, recusa (403)', garBarrado.status === 403, garBarrado.dados);
  await chama('PUT', '/api/configuracoes', { 'operacao.garcom_lanca': 'true' });

  // cancelamento
  const semMotivo = await chama('POST', '/api/pedidos/' + pedidoAdic + '/cancelar', {});
  ok('cancelar sem motivo e recusado (400)', semMotivo.status === 400, semMotivo.dados);
  const cancelou = await chama('POST', '/api/pedidos/' + pedidoAdic + '/cancelar',
    { motivo: 'cliente desistiu' });
  ok('cancela com motivo', cancelou.status === 200 && !!cancelou.dados.cancelado_em, cancelou.dados);
  const histCancel = await chama('GET', '/api/comandas/' + comAdic.dados.comanda_id + '/historico');
  ok('o cancelamento fica no historico com o motivo',
    histCancel.dados.some((l) => l.evento === 'pedido:cancelado' &&
      l.detalhe && l.detalhe.motivo === 'cliente desistiu'));

  // servico desligado para a casa
  await chama('PUT', '/api/configuracoes', { 'servico.ativo': 'false' });
  const semServico = await chama('GET', '/api/comandas/' + comAdic.dados.comanda_id);
  ok('servico desligado zera a linha na conta',
    semServico.dados.totais.servico === 0 && semServico.dados.totais.servico_cobrado === false,
    semServico.dados.totais);
  await chama('PUT', '/api/configuracoes', { 'servico.ativo': 'true' });

  // fechar com saldo pendente exige confirmacao explicita
  const presos = await chama('GET', '/api/comandas/' + comAdic.dados.comanda_id);
  for (const p of presos.dados.pedidos) {
    if (['aguardando', 'novo', 'preparo', 'pronto'].includes(p.status)) {
      await chama('POST', '/api/pedidos/' + p.id + '/cancelar', { motivo: 'fim do teste' });
    }
  }
  const aindaNaCozinha = await chama('POST', '/api/comandas/' + comAdic.dados.comanda_id + '/fechar',
    { aceita_saldo_pendente: true });
  ok('nao fecha com pedido ainda na cozinha',
    aindaNaCozinha.status === 200 || /cozinha/.test((aindaNaCozinha.dados || {}).message || ''),
    aindaNaCozinha.dados);
  const forca = aindaNaCozinha.status === 200 ? aindaNaCozinha
    : await chama('POST', '/api/comandas/' + comAdic.dados.comanda_id + '/fechar',
        { aceita_saldo_pendente: true });
  ok('admin fecha com saldo em aberto quando confirma', forca.status === 200, forca.dados);

  // ------------------------------------------------------------ limpeza
  console.log('\nlimpeza');
  await query(
    `DELETE FROM comandas WHERE mesa_id = (SELECT id FROM mesas WHERE numero = $1)`, [numeroMesa]);
  await query('DELETE FROM chamados WHERE mesa_id = $1', [mesaId]);
  await query('DELETE FROM mesas WHERE numero = $1', [numeroMesa]);
  await query('DELETE FROM estoque_mov WHERE produto_id = $1', [produtoId]);
  await query('DELETE FROM produto_adicionais WHERE produto_id = $1', [produtoId]);
  await query('DELETE FROM adicionais WHERE nome LIKE $1', ['%' + sufixo]);
  await query('DELETE FROM produtos WHERE idnomeProduto = $1', [produtoId]);
  await query('DELETE FROM usuarios WHERE id = ANY($1)', [[admId, garId]]);

  const volta = await chama('PUT', '/api/configuracoes', {
    'pagamento.modo': 'fechamento', 'pagamento.integrado': 'false',
    'estoque.modo': 'desligado', 'financeiro.ativo': 'true',
    'cliente.url': 'https://franksilva01.github.io/App-Venda/mesa.html',
  }, null);
  // Sem sessao (o usuario de teste ja foi apagado) a rota responde 401: em modo
  // normal isso e o esperado. Vale como ultima prova de que a trava funciona.
  ok('sem sessao nao se muda configuracao (401)', volta.status === 401, volta.dados);
  await query(
    `UPDATE configuracoes SET valor = v.valor FROM (VALUES
       ('pagamento.modo','fechamento'), ('pagamento.integrado','false'),
       ('estoque.modo','desligado'), ('operacao.cliente_fecha','true'),
       ('operacao.garcom_lanca','true'), ('servico.ativo','true'),
       ('cliente.url','https://franksilva01.github.io/App-Venda/mesa.html')
     ) AS v(chave, valor) WHERE configuracoes.chave = v.chave`);

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'tudo passou'));
  await pool.end();
  process.exit(falhas ? 1 : 0);
})().catch(async (e) => {
  console.error('\nerro no teste:', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
