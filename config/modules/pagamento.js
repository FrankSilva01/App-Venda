// MODULO OPCIONAL: pagamento integrado (Pix e cartao dentro do app).
//
// Desligado, nada aqui e montado e o fluxo segue inteiro: a conta fica aberta e
// o caixa recebe dinheiro, maquininha e Pix na chave da casa (isso e nucleo).
//
// A seta aponta deste modulo PARA o nucleo -- ele chama fluxo.liberarPedido.
// O nucleo nao conhece este arquivo.
//
// ATENCAO: nao ha adquirente de verdade aqui. `aprovar()` e um stub que diz
// sempre que sim. Trocar por Mercado Pago/Pagar.me/Stripe significa mexer SO
// nesta funcao -- e por isso que ela esta isolada no topo.
const express = require('express');
const { query } = require('../server/dbConnection');
const fluxo = require('./fluxo');

const router = express.Router();

// Taxa da adquirente por forma. Pix nao tem, e e isso que faz valer a pena
// oferecer: cai na hora e nao come 3% do prato.
const TAXAS = { pix: 0, cartao_credito: 0.032, cartao_debito: 0.018 };

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

const dinheiro = (v) => Math.round(Number(v || 0) * 100) / 100;

// STUB. Um gateway real devolve pendente e confirma depois, por webhook; por
// isso a resposta ja tem o formato { aprovado, referencia } em vez de um boolean.
async function aprovar(forma, valor) {
  return { aprovado: true, referencia: 'stub-' + Date.now(), forma, valor };
}

router.get('/formas', (req, res) => {
  res.json(Object.keys(TAXAS).map((f) => ({ forma: f, taxa_percentual: TAXAS[f] * 100 })));
});

// Pagar UM pedido (modo antecipado, ou "pagar agora" no modo ambos).
router.post('/pedido/:id', async (req, res) => {
  const { forma } = req.body || {};
  if (!(forma in TAXAS)) {
    return res.status(400).json({ message: 'Forma inválida. Use: ' + Object.keys(TAXAS).join(', ') + '.' });
  }
  const id = Number(req.params.id);
  try {
    const p = await query(
      `SELECT p.id, p.status, p.comanda_id,
              COALESCE(SUM(it.preco * it.quantidade), 0) AS valor
         FROM pedidos p LEFT JOIN pedido_itens it ON it.pedido_id = p.id
        WHERE p.id = $1 GROUP BY p.id`,
      [id]
    );
    if (!p.rows.length) return res.status(404).json({ message: 'Pedido não encontrado.' });
    if (p.rows[0].status === 'cancelado') {
      return res.status(409).json({ message: 'Pedido cancelado.' });
    }

    const jaPago = await query(
      'SELECT COALESCE(SUM(valor), 0) AS pago FROM pagamentos WHERE pedido_id = $1', [id]
    );
    if (dinheiro(jaPago.rows[0].pago) > 0) {
      return res.status(409).json({ message: 'Esse pedido já foi pago.' });
    }

    const valor = dinheiro(p.rows[0].valor);
    const r = await aprovar(forma, valor);
    if (!r.aprovado) return res.status(402).json({ message: 'Pagamento recusado.' });

    const pg = await query(
      `INSERT INTO pagamentos (comanda_id, pedido_id, forma, origem, valor, taxa)
       VALUES ($1, $2, $3, 'app', $4, $5) RETURNING *`,
      [p.rows[0].comanda_id, id, forma, valor, dinheiro(valor * TAXAS[forma])]
    );

    // AQUI o pedido entra na cozinha. Enquanto o pagamento nao aprova, o card
    // nao existe para o cozinheiro.
    const liberado = await fluxo.liberarPedido(id, 'pagamento aprovado');

    res.status(201).json({
      pagamento: pg.rows[0],
      // false quando o pedido ja estava na fila (modo ambos: pagou depois de
      // mandar). Nao e erro -- so nao havia o que liberar.
      liberou_cozinha: !!liberado,
      totais: await fluxo.totalComanda(p.rows[0].comanda_id),
    });
  } catch (e) { erro(res, e, 'Erro ao processar o pagamento'); }
});

// Pagar a comanda inteira pelo celular, sem ir ao caixa.
router.post('/comanda/:id', async (req, res) => {
  const { forma, valor } = req.body || {};
  if (!(forma in TAXAS)) {
    return res.status(400).json({ message: 'Forma inválida. Use: ' + Object.keys(TAXAS).join(', ') + '.' });
  }
  const id = Number(req.params.id);
  try {
    const totais = await fluxo.totalComanda(id);
    if (!totais) return res.status(404).json({ message: 'Comanda não encontrada.' });

    // Sem valor, paga o que falta. Com valor, e pagamento parcial (conta dividida).
    const alvo = valor === undefined ? totais.saldo : dinheiro(valor);
    if (!(alvo > 0)) return res.status(400).json({ message: 'Nada a pagar nessa comanda.' });

    const r = await aprovar(forma, alvo);
    if (!r.aprovado) return res.status(402).json({ message: 'Pagamento recusado.' });

    const pg = await query(
      `INSERT INTO pagamentos (comanda_id, forma, origem, valor, taxa)
       VALUES ($1, $2, 'app', $3, $4) RETURNING *`,
      [id, forma, alvo, dinheiro(alvo * TAXAS[forma])]
    );
    res.status(201).json({ pagamento: pg.rows[0], totais: await fluxo.totalComanda(id) });
  } catch (e) { erro(res, e, 'Erro ao processar o pagamento'); }
});

module.exports = { router };
