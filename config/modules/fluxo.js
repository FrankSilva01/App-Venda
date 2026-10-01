// NUCLEO: QR -> pedido -> cozinha -> comanda -> caixa -> fechamento.
//
// Este arquivo funciona com pagamento, estoque e financeiro TODOS desligados.
// Por isso ele nao da require em nenhum deles -- so em banco, configuracao e
// barramento. Quem depende de quem:
//
//     modules/pagamento.js  ->  fluxo (chama liberarPedido)
//     modules/estoque.js    ->  eventos (escuta pedido:liberado)
//     modules/financeiro.js ->  banco (so le)
//     fluxo.js              ->  ninguem
//
// A seta nunca aponta do nucleo para um modulo. E isso que deixa desligar.
const express = require('express');
const { query, transacao } = require('../server/dbConnection');
const cfg = require('../server/configuracoes');
const eventos = require('../server/eventos');

const router = express.Router();

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

const dinheiro = (v) => Math.round(Number(v || 0) * 100) / 100;

// ------------------------------------------------------------------ totais
// Uma unica funcao calcula o total em todo lugar (comanda, caixa, fechamento).
// Dois calculos do mesmo total e a forma mais rapida de a conta do cliente nao
// bater com a do caixa.
async function totalComanda(comandaId) {
  const c = await query('SELECT servico, desconto FROM comandas WHERE id = $1', [comandaId]);
  if (!c.rows.length) return null;

  // Pedido cancelado nao entra. O resto entra, inclusive o que ainda nao foi
  // para a cozinha -- o cliente ja se comprometeu com ele.
  const i = await query(
    `SELECT COALESCE(SUM(it.preco * it.quantidade), 0) AS consumo
       FROM pedido_itens it
       JOIN pedidos p ON p.id = it.pedido_id
      WHERE p.comanda_id = $1 AND p.status <> 'cancelado'`,
    [comandaId]
  );
  const p = await query(
    'SELECT COALESCE(SUM(valor), 0) AS pago FROM pagamentos WHERE comanda_id = $1',
    [comandaId]
  );

  const pct = Number(await cfg.ler('servico.percentual'));
  const consumo = dinheiro(i.rows[0].consumo);
  const servico = c.rows[0].servico ? dinheiro(consumo * (pct / 100)) : 0;
  const desconto = dinheiro(c.rows[0].desconto);
  const total = dinheiro(consumo + servico - desconto);
  const pago = dinheiro(p.rows[0].pago);

  return {
    consumo,
    servico,
    servico_percentual: pct,
    desconto,
    total,
    pago,
    saldo: dinheiro(total - pago),
  };
}

// --------------------------------------------------------- liberar pedido
// Porta de entrada da cozinha. O nucleo chama direto; o modulo de pagamento
// chama daqui quando aprova. Idempotente de proposito: webhook de adquirente
// repete, e repetir nao pode fazer o pedido entrar duas vezes na fila.
async function liberarPedido(pedidoId, motivo) {
  const r = await query(
    `UPDATE pedidos SET status = 'novo', liberado_em = now()
      WHERE id = $1 AND status = 'aguardando'
      RETURNING *`,
    [pedidoId]
  );
  if (!r.rows.length) return null;

  const itens = await query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);
  const pedido = r.rows[0];
  eventos.emitir('pedido:liberado', { pedido, itens: itens.rows, motivo: motivo || 'confirmado' });
  return pedido;
}

// ----------------------------------------------------------------- mesas
router.get('/mesas', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.*, c.id AS comanda_id, c.aberta_em
         FROM mesas m
         LEFT JOIN comandas c ON c.mesa_id = m.id AND c.status = 'aberta'
        ORDER BY m.numero`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar as mesas'); }
});

router.post('/mesas', async (req, res) => {
  const { numero, apelido } = req.body || {};
  if (!numero) return res.status(400).json({ message: 'Informe o número da mesa.' });
  try {
    const r = await query(
      'INSERT INTO mesas (numero, apelido) VALUES ($1, $2) RETURNING *',
      [Number(numero), apelido || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ message: 'Essa mesa já existe.' });
    erro(res, e, 'Erro ao criar a mesa');
  }
});

// O que o QR da mesa abre. Sem login, sem cadastro: o numero da mesa vem na URL.
router.get('/mesa/:numero/cardapio', async (req, res) => {
  try {
    const m = await query('SELECT * FROM mesas WHERE numero = $1 AND ativa', [Number(req.params.numero)]);
    if (!m.rows.length) return res.status(404).json({ message: 'Mesa não encontrada.' });

    // Indisponivel nao aparece. Nao adianta mostrar e recusar depois -- quem
    // decide o que esta disponivel e a coluna, venha ela do estoque ou da mao.
    const prod = await query(
      'SELECT * FROM produtos WHERE disponivel ORDER BY categoria, nomeProduto'
    );
    const comanda = await query(
      "SELECT * FROM comandas WHERE mesa_id = $1 AND status = 'aberta'",
      [m.rows[0].id]
    );

    const modo = await cfg.ler('pagamento.modo');
    const integrado = await cfg.ligado('pagamento.integrado');

    res.json({
      mesa: m.rows[0],
      produtos: prod.rows,
      comanda: comanda.rows[0] || null,
      // O cardapio ja diz ao celular quais botoes existem, para a tela nao
      // precisar conhecer a regra de negocio.
      pagamento: {
        modo,
        pode_pagar_agora: integrado && (modo === 'antecipado' || modo === 'ambos'),
        exige_pagar_agora: integrado && modo === 'antecipado',
      },
    });
  } catch (e) { erro(res, e, 'Erro ao carregar o cardápio'); }
});

// -------------------------------------------------------------- comandas
async function comandaAberta(mesaId, cliente) {
  const exec = cliente ? (s, v) => cliente.query(s, v) : (s, v) => query(s, v);
  const achou = await exec("SELECT * FROM comandas WHERE mesa_id = $1 AND status = 'aberta'", [mesaId]);
  if (achou.rows.length) return achou.rows[0];
  const nova = await exec('INSERT INTO comandas (mesa_id) VALUES ($1) RETURNING *', [mesaId]);
  return nova.rows[0];
}

router.get('/comandas', async (req, res) => {
  const status = req.query.status || 'aberta';
  try {
    const r = await query(
      `SELECT c.*, m.numero AS mesa
         FROM comandas c JOIN mesas m ON m.id = c.mesa_id
        WHERE c.status = $1 ORDER BY c.aberta_em`,
      [status]
    );
    // Lista do caixa: cada linha precisa do total, senao a tela faz N chamadas.
    const comTotais = [];
    for (const c of r.rows) comTotais.push(Object.assign(c, { totais: await totalComanda(c.id) }));
    res.json(comTotais);
  } catch (e) { erro(res, e, 'Erro ao listar as comandas'); }
});

router.get('/comandas/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const c = await query(
      `SELECT c.*, m.numero AS mesa FROM comandas c
         JOIN mesas m ON m.id = c.mesa_id WHERE c.id = $1`,
      [id]
    );
    if (!c.rows.length) return res.status(404).json({ message: 'Comanda não encontrada.' });

    const pedidos = await query('SELECT * FROM pedidos WHERE comanda_id = $1 ORDER BY id', [id]);
    const itens = await query(
      `SELECT it.* FROM pedido_itens it JOIN pedidos p ON p.id = it.pedido_id
        WHERE p.comanda_id = $1 ORDER BY it.id`,
      [id]
    );
    const pagamentos = await query(
      'SELECT * FROM pagamentos WHERE comanda_id = $1 ORDER BY id', [id]
    );

    res.json({
      comanda: c.rows[0],
      pedidos: pedidos.rows.map((p) =>
        Object.assign(p, { itens: itens.rows.filter((i) => i.pedido_id === p.id) })),
      pagamentos: pagamentos.rows,
      totais: await totalComanda(id),
    });
  } catch (e) { erro(res, e, 'Erro ao carregar a comanda'); }
});

router.patch('/comandas/:id', async (req, res) => {
  const { servico, desconto } = req.body || {};
  try {
    const r = await query(
      `UPDATE comandas
          SET servico  = COALESCE($2, servico),
              desconto = COALESCE($3, desconto)
        WHERE id = $1 AND status = 'aberta'
        RETURNING *`,
      [Number(req.params.id),
       servico === undefined ? null : !!servico,
       desconto === undefined ? null : dinheiro(desconto)]
    );
    if (!r.rows.length) return res.status(409).json({ message: 'Comanda não está aberta.' });
    res.json({ comanda: r.rows[0], totais: await totalComanda(r.rows[0].id) });
  } catch (e) { erro(res, e, 'Erro ao ajustar a comanda'); }
});

// Pagamento lancado no caixa, a mao. Existe SEM o modulo de pagamento: dinheiro,
// maquininha e Pix na chave da casa sao o caso normal da maioria dos bares.
router.post('/comandas/:id/pagamentos', async (req, res) => {
  const { forma, valor } = req.body || {};
  const formasCaixa = ['dinheiro', 'cartao_maquina', 'pix_chave'];
  if (!formasCaixa.includes(forma)) {
    return res.status(400).json({ message: 'Forma inválida. Use: ' + formasCaixa.join(', ') + '.' });
  }
  if (!(Number(valor) > 0)) return res.status(400).json({ message: 'Valor deve ser maior que zero.' });
  try {
    const c = await query('SELECT status FROM comandas WHERE id = $1', [Number(req.params.id)]);
    if (!c.rows.length) return res.status(404).json({ message: 'Comanda não encontrada.' });
    if (c.rows[0].status !== 'aberta') return res.status(409).json({ message: 'Comanda já fechada.' });

    const r = await query(
      `INSERT INTO pagamentos (comanda_id, forma, origem, valor) VALUES ($1, $2, 'caixa', $3)
       RETURNING *`,
      [Number(req.params.id), forma, dinheiro(valor)]
    );
    res.status(201).json({ pagamento: r.rows[0], totais: await totalComanda(Number(req.params.id)) });
  } catch (e) { erro(res, e, 'Erro ao lançar o pagamento'); }
});

router.post('/comandas/:id/fechar', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const totais = await totalComanda(id);
    if (!totais) return res.status(404).json({ message: 'Comanda não encontrada.' });
    // Centavo de tolerancia: 1/3 de R$ 283,80 nao fecha exato em divisao.
    if (totais.saldo > 0.01) {
      return res.status(409).json({
        message: 'Ainda faltam ' + totais.saldo.toFixed(2) + ' para fechar.',
        totais,
      });
    }
    const aberto = await query(
      `SELECT COUNT(*)::int AS n FROM pedidos
        WHERE comanda_id = $1 AND status IN ('aguardando', 'novo', 'preparo')`,
      [id]
    );
    if (aberto.rows[0].n) {
      return res.status(409).json({ message: 'Há ' + aberto.rows[0].n + ' pedido(s) ainda na cozinha.' });
    }

    const r = await query(
      `UPDATE comandas SET status = 'fechada', fechada_em = now()
        WHERE id = $1 AND status = 'aberta' RETURNING *`,
      [id]
    );
    if (!r.rows.length) return res.status(409).json({ message: 'Comanda já estava fechada.' });

    eventos.emitir('comanda:fechada', { comanda: r.rows[0], totais });
    res.json({ comanda: r.rows[0], totais });
  } catch (e) { erro(res, e, 'Erro ao fechar a comanda'); }
});

// --------------------------------------------------------------- pedidos
router.post('/pedidos', async (req, res) => {
  const { mesa, cliente, itens, pagar_agora } = req.body || {};
  if (!mesa) return res.status(400).json({ message: 'Informe a mesa.' });
  if (!Array.isArray(itens) || !itens.length) {
    return res.status(400).json({ message: 'O pedido está vazio.' });
  }

  try {
    const modo = await cfg.ler('pagamento.modo');
    const integrado = await cfg.ligado('pagamento.integrado');

    // Quem decide se o pedido espera pagamento e ESTA linha, e so ela. O modulo
    // de pagamento nao e consultado: le-se a configuracao, nao o modulo.
    let esperaPagamento = integrado && (modo === 'antecipado' || (modo === 'ambos' && !!pagar_agora));

    // Rede de seguranca: configuracao pede "so depois de pago" mas a cobranca
    // esta desligada. Em vez de o pedido sumir, ele vai para a cozinha e a
    // resposta avisa. Nao ha cenario em que a comida deixa de ser feita.
    let aviso = null;
    if (modo === 'antecipado' && !integrado) {
      aviso = 'Pagamento antecipado configurado sem o módulo de pagamento: o pedido foi direto para a cozinha.';
      esperaPagamento = false;
    }

    const criado = await transacao(async (cx) => {
      const m = await cx.query('SELECT * FROM mesas WHERE numero = $1 AND ativa', [Number(mesa)]);
      if (!m.rows.length) { const e = new Error('Mesa não encontrada.'); e.status = 404; throw e; }

      const comanda = await comandaAberta(m.rows[0].id, cx);

      const p = await cx.query(
        `INSERT INTO pedidos (comanda_id, cliente, status, liberado_em)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [comanda.id, cliente || null,
         esperaPagamento ? 'aguardando' : 'novo',
         esperaPagamento ? null : new Date()]
      );

      const gravados = [];
      for (const item of itens) {
        const prod = await cx.query(
          'SELECT idnomeProduto, nomeProduto, precoProduto, disponivel FROM produtos WHERE idnomeProduto = $1',
          [Number(item.produto_id)]
        );
        if (!prod.rows.length) {
          const e = new Error('Produto ' + item.produto_id + ' não existe.'); e.status = 400; throw e;
        }
        if (!prod.rows[0].disponivel) {
          const e = new Error(prod.rows[0].nomeproduto + ' está indisponível.'); e.status = 409; throw e;
        }
        const qtd = Number(item.quantidade || 1);
        if (!(qtd > 0)) { const e = new Error('Quantidade inválida.'); e.status = 400; throw e; }

        const i = await cx.query(
          `INSERT INTO pedido_itens (pedido_id, produto_id, nome, preco, quantidade, observacao)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [p.rows[0].id, prod.rows[0].idnomeproduto, prod.rows[0].nomeproduto,
           prod.rows[0].precoproduto, qtd, item.observacao || null]
        );
        gravados.push(i.rows[0]);
      }
      return { pedido: p.rows[0], itens: gravados, comanda };
    });

    eventos.emitir('pedido:criado', criado);
    if (!esperaPagamento) {
      eventos.emitir('pedido:liberado', Object.assign({ motivo: 'confirmado' }, criado));
    }

    res.status(201).json({
      pedido: criado.pedido,
      itens: criado.itens,
      comanda_id: criado.comanda.id,
      na_cozinha: !esperaPagamento,
      totais: await totalComanda(criado.comanda.id),
      aviso,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    erro(res, e, 'Erro ao registrar o pedido');
  }
});

// --------------------------------------------------------------- cozinha
router.get('/cozinha', async (req, res) => {
  try {
    const r = await query(
      `SELECT p.*, m.numero AS mesa,
              EXTRACT(EPOCH FROM (now() - p.liberado_em))::int AS segundos_na_fila
         FROM pedidos p
         JOIN comandas c ON c.id = p.comanda_id
         JOIN mesas m    ON m.id = c.mesa_id
        WHERE p.status IN ('novo', 'preparo', 'pronto')
        ORDER BY p.liberado_em`
    );
    const itens = await query(
      `SELECT it.* FROM pedido_itens it JOIN pedidos p ON p.id = it.pedido_id
        WHERE p.status IN ('novo', 'preparo', 'pronto') ORDER BY it.id`
    );
    res.json(r.rows.map((p) =>
      Object.assign(p, { itens: itens.rows.filter((i) => i.pedido_id === p.id) })));
  } catch (e) { erro(res, e, 'Erro ao carregar a fila da cozinha'); }
});

// Avanco de etapa. Cada passo so sai do estado anterior: dois cozinheiros
// clicando no mesmo card nao pulam o pedido de 'novo' direto para 'entregue'.
const PASSOS = {
  preparo:  { de: ['novo'],    campo: null },
  pronto:   { de: ['preparo', 'novo'], campo: 'pronto_em' },
  entregue: { de: ['pronto'],  campo: 'entregue_em' },
};

Object.keys(PASSOS).forEach((destino) => {
  router.post('/pedidos/:id/' + destino, async (req, res) => {
    const passo = PASSOS[destino];
    try {
      const r = await query(
        `UPDATE pedidos SET status = $2` + (passo.campo ? ', ' + passo.campo + ' = now()' : '') +
        `  WHERE id = $1 AND status = ANY($3) RETURNING *`,
        [Number(req.params.id), destino, passo.de]
      );
      if (!r.rows.length) {
        return res.status(409).json({ message: 'O pedido não está em um estado que permita isso.' });
      }
      eventos.emitir('pedido:' + destino, { pedido: r.rows[0] });
      res.json(r.rows[0]);
    } catch (e) { erro(res, e, 'Erro ao mudar o pedido de etapa'); }
  });
});

router.post('/pedidos/:id/cancelar', async (req, res) => {
  try {
    const r = await query(
      `UPDATE pedidos SET status = 'cancelado'
        WHERE id = $1 AND status IN ('aguardando', 'novo', 'preparo') RETURNING *`,
      [Number(req.params.id)]
    );
    if (!r.rows.length) {
      return res.status(409).json({ message: 'Pedido já pronto, entregue ou cancelado.' });
    }
    const itens = await query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [r.rows[0].id]);
    // O estoque escuta para devolver o que ja tinha baixado.
    eventos.emitir('pedido:cancelado', { pedido: r.rows[0], itens: itens.rows });
    res.json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao cancelar o pedido'); }
});

module.exports = { router, liberarPedido, totalComanda };
