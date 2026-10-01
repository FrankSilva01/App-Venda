// Prova de que a auditoria liga PESSOA + AÇÃO + MESA + HORÁRIO.
//
// Encena um turno curto com dois funcionários de perfis diferentes e, no fim,
// imprime o histórico como uma pessoa leria. Serve de teste e de demonstração:
// se alguém quebrar o registro de autoria, esta saída mostra na hora.
//
//   node scripts/auditoria-demo.js
const bcrypt = require('bcryptjs');
const { pool, query } = require('../config/server/dbConnection');

const API = process.env.API || 'http://localhost:' + (process.env.PORT || 3001);
const sufixo = Math.random().toString(36).slice(2, 7);

async function chama(metodo, caminho, corpo, token) {
  const headers = {};
  if (corpo) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + caminho, {
    method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, dados: d };
}

async function criaUsuario(login, perfil, nome) {
  const hash = await bcrypt.hash('demo123456', 10);
  const r = await query(
    `INSERT INTO usuarios (login, nome, email, cpf, senha, perfil)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [login, nome, login + '@demo', 'cpf-' + login, hash, perfil]
  );
  const s = await chama('POST', '/api/login', { login, senha: 'demo123456' });
  return { id: r.rows[0].id, token: s.dados.token, nome };
}

(async () => {
  const garcom = await criaUsuario('demo-garcom-' + sufixo, 'garcom', 'Rafael (garçom)');
  const caixa = await criaUsuario('demo-caixa-' + sufixo, 'caixa', 'Joana (caixa)');
  const adm = await criaUsuario('demo-adm-' + sufixo, 'admin', 'Admin');

  await chama('PUT', '/api/configuracoes', {
    'pagamento.modo': 'fechamento', 'pagamento.integrado': 'false',
    'operacao.garcom_lanca': 'true', 'operacao.cliente_fecha': 'true',
  }, adm.token);

  const numero = 800 + Math.floor(Math.random() * 99);
  const mesa = await chama('POST', '/api/mesas', { numero, area: 'Deck' }, adm.token);
  const qr = await chama('POST', '/api/mesas/' + mesa.dados.id + '/qrcode', null, adm.token);
  const token = qr.dados.mesa.qr_token;

  const prod = await query(
    `INSERT INTO produtos (nomeProduto, precoProduto, descricaoProduto, quantidadeProduto, categoria)
     VALUES ($1, 25.00, 'demo', 10, 'demo') RETURNING idnomeProduto`, ['Demo ' + sufixo]
  );
  const produtoId = prod.rows[0].idnomeproduto;

  // 1. cliente pede pelo QR
  const ped = await chama('POST', '/api/pedidos',
    { token, cliente: 'Marina', itens: [{ produto_id: produtoId, quantidade: 2 }] });
  const comandaId = ped.dados.comanda_id;

  // 2. cozinha produz (o admin faz o papel aqui)
  for (const etapa of ['preparo', 'pronto', 'entregue']) {
    await chama('POST', '/api/pedidos/' + ped.dados.pedido.id + '/' + etapa, null, adm.token);
  }

  // 3. o cliente chama o garçom, e o GARÇOM resolve
  const ch = await chama('POST', '/api/qr/' + token + '/chamado', { tipo: 'atendimento' });
  await chama('POST', '/api/chamados/' + ch.dados.chamado.id + '/resolver', null, garcom.token);

  // 4. o garçom lança mais um item
  await chama('POST', '/api/pedidos',
    { mesa: numero, itens: [{ produto_id: produtoId, quantidade: 1 }] }, garcom.token);
  const naFila = await chama('GET', '/api/cozinha', null, adm.token);
  const doGarcom = naFila.dados.filter((p) => p.mesa === numero);
  for (const p of doGarcom) {
    for (const etapa of ['preparo', 'pronto', 'entregue']) {
      await chama('POST', '/api/pedidos/' + p.id + '/' + etapa, null, adm.token);
    }
  }

  // 5. o cliente pede a conta e o CAIXA recebe e fecha
  await chama('POST', '/api/qr/' + token + '/chamado', { tipo: 'fechamento' });
  const totais = await chama('GET', '/api/comandas/' + comandaId, null, caixa.token);
  await chama('POST', '/api/comandas/' + comandaId + '/pagamentos',
    { forma: 'dinheiro', valor: totais.dados.totais.saldo }, caixa.token);
  await chama('POST', '/api/comandas/' + comandaId + '/fechar', null, caixa.token);

  // ---------------------------------------------------------------- leitura
  // A auditoria grava pelo barramento, fora da requisição: o `fechar` já
  // respondeu, mas o INSERT do histórico pode ainda estar a caminho. Sem esta
  // espera o teste lia o histórico antes do último evento chegar -- e o
  // relatório saía sem o fechamento, parecendo falha de registro.
  await new Promise((r) => setTimeout(r, 600));

  const h = await query(
    `SELECT a.criado_em, a.evento, a.origem, a.detalhe, m.numero AS mesa,
            COALESCE(u.nome, u.login) AS quem, u.perfil
       FROM auditoria a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       LEFT JOIN mesas m    ON m.id = a.mesa_id
      WHERE a.comanda_id = $1 OR a.mesa_id = $2
      ORDER BY a.id`,
    [comandaId, mesa.dados.id]
  );

  const frases = {
    'comanda:aberta': () => 'abriu a conta',
    'pedido:criado': (l) => 'registrou um pedido' + (l.origem === 'qr' ? ' (cliente, pelo QR)' : ''),
    'pedido:liberado': () => 'liberou o pedido para a cozinha',
    'pedido:preparo': () => 'iniciou o preparo',
    'pedido:pronto': () => 'marcou pronto',
    'pedido:entregue': () => 'entregou na mesa',
    'pedido:cancelado': (l) => 'cancelou o pedido (' + (l.detalhe && l.detalhe.motivo) + ')',
    'chamado:atendimento': () => 'CLIENTE chamou o garçom',
    'chamado:fechamento': () => 'CLIENTE solicitou o fechamento',
    'chamado:assumido': () => 'assumiu o chamado',
    'chamado:resolvido': (l) => 'atendeu o chamado de ' +
      ((l.detalhe && l.detalhe.tipo) === 'fechamento' ? 'fechamento' : 'atendimento'),
    pagamento: (l) => 'recebeu ' + (l.detalhe ? 'R$ ' + Number(l.detalhe.valor).toFixed(2) : '') +
      ' em ' + (l.detalhe && l.detalhe.forma),
    'comanda:fechada': (l) => 'encerrou a mesa (total R$ ' +
      (l.detalhe ? Number(l.detalhe.total).toFixed(2) : '?') + ')',
  };

  console.log('\nHistórico da mesa ' + numero + ':\n');
  // Eventos que, por natureza, NÃO têm funcionário: o cliente agiu pelo QR, ou
  // é consequência automática de outro evento. Exigir autor neles seria exigir
  // um nome que não existe.
  const semDono = (l) =>
    l.origem === 'qr' ||
    l.evento === 'pedido:liberado' ||
    l.evento === 'comanda:aberta' ||
    /^chamado:(atendimento|fechamento)$/.test(l.evento);

  let faltando = 0;
  h.rows.forEach((l) => {
    const hora = new Date(l.criado_em).toLocaleTimeString('pt-BR');
    const texto = (frases[l.evento] || (() => l.evento))(l);
    let autor;
    if (l.quem) autor = l.quem + ' [' + l.perfil + ']';
    else if (semDono(l)) autor = l.origem === 'qr' ? 'cliente (QR)' : 'sistema';
    else { autor = '(SEM AUTOR)'; faltando++; }
    console.log('  ' + hora + '  ' + autor.padEnd(24) + texto.padEnd(42) + 'mesa ' + (l.mesa || '?'));
  });

  const semMesa = h.rows.filter((l) => !l.mesa).length;
  console.log('\n' + (faltando
    ? faltando + ' evento(s) de funcionário sem autor — verificar'
    : 'Todo evento de funcionário tem nome, perfil, mesa e horário.'));
  if (semMesa) console.log(semMesa + ' evento(s) sem mesa — verificar');

  // limpeza
  await query('DELETE FROM comandas WHERE mesa_id = $1', [mesa.dados.id]);
  await query('DELETE FROM chamados WHERE mesa_id = $1', [mesa.dados.id]);
  await query('DELETE FROM mesas WHERE id = $1', [mesa.dados.id]);
  await query('DELETE FROM produtos WHERE idnomeProduto = $1', [produtoId]);
  await query('DELETE FROM usuarios WHERE id = ANY($1)', [[garcom.id, caixa.id, adm.id]]);

  await pool.end();
  process.exit(faltando || semMesa ? 1 : 0);
})().catch(async (e) => {
  console.error('falhou:', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
