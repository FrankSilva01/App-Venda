// Historico de tudo que aconteceu na operacao.
//
// Nao tem tela propria ainda, de proposito: o que nao pode faltar e o DADO.
// Relatorio de divergencia de caixa, discussao sobre pedido cancelado e
// reclamacao de demora sao sempre investigados DEPOIS, e quem nao gravou na
// hora nao tem como voltar atras.
//
// Escuta o barramento em vez de ser chamado de dentro das rotas: assim nenhuma
// rota precisa lembrar de registrar, e esquecer de registrar e o jeito classico
// de a auditoria ter buracos.
const { query } = require('./dbConnection');
const eventos = require('./eventos');

async function registra(evento, dados) {
  let mesaId = dados.mesa_id || null;

  // Preenche a mesa a partir da comanda quando o evento não a trouxe.
  //
  // Dá para descobrir a mesa com um JOIN na hora da consulta -- mas só enquanto
  // a comanda existir, e esta tabela existe justamente para sobreviver ao que
  // for apagado. Uma consulta a mais aqui (fora do caminho da requisição, já
  // que isto roda no barramento) deixa cada linha se explicando sozinha.
  if (!mesaId && dados.comanda_id) {
    try {
      const r = await query('SELECT mesa_id FROM comandas WHERE id = $1', [dados.comanda_id]);
      mesaId = r.rows[0] ? r.rows[0].mesa_id : null;
    } catch (e) { /* sem mesa é melhor que sem registro */ }
  }

  await query(
    `INSERT INTO auditoria (evento, mesa_id, comanda_id, pedido_id, usuario_id, origem, detalhe)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [evento, mesaId, dados.comanda_id || null, dados.pedido_id || null,
     dados.usuario_id || null, dados.origem || null,
     dados.detalhe === undefined ? null : JSON.stringify(dados.detalhe)]
  );
}

eventos.on('pedido:criado', ({ pedido, itens, comanda }) => registra('pedido:criado', {
  mesa_id: comanda && comanda.mesa_id, comanda_id: pedido.comanda_id, pedido_id: pedido.id,
  usuario_id: pedido.usuario_id, origem: pedido.origem,
  detalhe: { cliente: pedido.cliente, itens: (itens || []).length, status: pedido.status },
}));

eventos.on('pedido:liberado', ({ pedido, motivo }) => registra('pedido:liberado', {
  comanda_id: pedido.comanda_id, pedido_id: pedido.id, origem: pedido.origem,
  detalhe: { motivo },
}));

['preparo', 'pronto', 'entregue'].forEach((etapa) => {
  eventos.on('pedido:' + etapa, ({ pedido, usuario }) => registra('pedido:' + etapa, {
    comanda_id: pedido.comanda_id, pedido_id: pedido.id,
    usuario_id: usuario ? usuario.id : null,
  }));
});

eventos.on('pedido:cancelado', ({ pedido, usuario, motivo }) => registra('pedido:cancelado', {
  comanda_id: pedido.comanda_id, pedido_id: pedido.id,
  usuario_id: usuario ? usuario.id : null,
  detalhe: { motivo: motivo || null },
}));

eventos.on('comanda:aberta', ({ comanda }) => registra('comanda:aberta', {
  mesa_id: comanda.mesa_id, comanda_id: comanda.id,
}));

eventos.on('comanda:fechada', ({ comanda, totais, usuario }) => registra('comanda:fechada', {
  mesa_id: comanda.mesa_id, comanda_id: comanda.id,
  usuario_id: usuario ? usuario.id : null,
  detalhe: totais,
}));

eventos.on('pagamento:registrado', ({ pagamento, usuario }) => registra('pagamento', {
  comanda_id: pagamento.comanda_id, pedido_id: pagamento.pedido_id,
  usuario_id: usuario ? usuario.id : null, origem: pagamento.origem,
  detalhe: { forma: pagamento.forma, valor: Number(pagamento.valor), taxa: Number(pagamento.taxa) },
}));

eventos.on('chamado:aberto', ({ chamado }) => registra('chamado:' + chamado.tipo, {
  mesa_id: chamado.mesa_id, comanda_id: chamado.comanda_id,
}));

eventos.on('chamado:assumido', ({ chamado, usuario }) => registra('chamado:assumido', {
  mesa_id: chamado.mesa_id, comanda_id: chamado.comanda_id,
  usuario_id: usuario ? usuario.id : null, detalhe: { tipo: chamado.tipo },
}));

// Faltava. E o evento que a interface realmente dispara -- o botao da gaveta
// resolve direto, sem passar por "assumir" -- entao sem este ouvinte ninguem
// sabia QUEM atendeu a mesa que chamou.
eventos.on('chamado:resolvido', ({ chamado, usuario }) => registra('chamado:resolvido', {
  mesa_id: chamado.mesa_id, comanda_id: chamado.comanda_id,
  usuario_id: usuario ? usuario.id : (chamado.usuario_id || null),
  detalhe: { tipo: chamado.tipo },
}));

// Historico de uma comanda, para a tela do caixa e para conferencia depois.
async function daComanda(comandaId) {
  const r = await query(
    `SELECT a.*, u.login AS usuario
       FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.comanda_id = $1 ORDER BY a.id`,
    [comandaId]
  );
  return r.rows;
}

module.exports = { registra, daComanda };
