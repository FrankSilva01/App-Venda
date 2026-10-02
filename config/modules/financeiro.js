// MODULO OPCIONAL: relatorios financeiros.
//
// So SELECT. Nenhuma rota daqui altera uma linha, nenhuma e chamada pelo nucleo
// e este arquivo nao escuta evento nenhum -- nao ha o que ele possa travar.
// Desligar o modulo, ou o banco de relatorio cair, nao muda nada no salao.
//
// Os numeros saem de pagamentos e pedido_itens, que o nucleo ja grava. O
// financeiro nao mantem tabela propria de proposito: segunda copia do mesmo
// valor e a origem classica de relatorio que nao bate com o caixa.
const express = require('express');
const { query } = require('../server/dbConnection');
const datas = require('../server/datas');

const router = express.Router();

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

// Janela do relatorio. Sem parametro, e o dia de hoje NO FUSO DA CASA.
//
// A versao anterior usava o dia em UTC: no Brasil, das 21h a meia-noite o
// "faturamento de hoje" zerava e so voltava no dia seguinte -- bem no pico do
// jantar. Ver config/server/datas.js.
function janela(req) {
  const j = datas.janela(req.query.de, req.query.ate);
  return [j.inicio, j.fim, j.fuso];
}

router.get('/resumo', async (req, res) => {
  const [de, ate, fuso] = janela(req);
  try {
    const pg = await query(
      `SELECT COALESCE(SUM(valor), 0)        AS bruto,
              COALESCE(SUM(taxa), 0)         AS taxas,
              COUNT(DISTINCT comanda_id)::int AS comandas
         FROM pagamentos WHERE criado_em >= ($1::date)::timestamp AT TIME ZONE $3
          AND criado_em <  (($2::date) + 1)::timestamp AT TIME ZONE $3`,
      [de, ate, fuso]
    );
    const pd = await query(
      `SELECT COUNT(*)::int AS pedidos,
              COALESCE(AVG(EXTRACT(EPOCH FROM (pronto_em - liberado_em))), 0)::int AS preparo_medio_s
         FROM pedidos
        WHERE status <> 'cancelado' AND criado_em >= ($1::date)::timestamp AT TIME ZONE $3
          AND criado_em <  (($2::date) + 1)::timestamp AT TIME ZONE $3`,
      [de, ate, fuso]
    );

    const bruto = Number(pg.rows[0].bruto);
    const comandas = pg.rows[0].comandas;
    res.json({
      periodo: { de: req.query.de || null, ate: req.query.ate || null },
      bruto,
      taxas: Number(pg.rows[0].taxas),
      liquido: Math.round((bruto - Number(pg.rows[0].taxas)) * 100) / 100,
      comandas,
      pedidos: pd.rows[0].pedidos,
      // Ticket medio por COMANDA (mesa), nao por pedido: a mesa que pede tres
      // vezes e um cliente so, e dividir por pedido faz o numero despencar sem
      // nada ter piorado.
      ticket_medio: comandas ? Math.round((bruto / comandas) * 100) / 100 : 0,
      preparo_medio_min: Math.round(pd.rows[0].preparo_medio_s / 60),
    });
  } catch (e) { erro(res, e, 'Erro ao montar o resumo'); }
});

router.get('/formas', async (req, res) => {
  const [de, ate, fuso] = janela(req);
  try {
    const r = await query(
      `SELECT forma, origem, COUNT(*)::int AS qtd,
              SUM(valor) AS bruto, SUM(taxa) AS taxas
         FROM pagamentos WHERE criado_em >= ($1::date)::timestamp AT TIME ZONE $3
          AND criado_em <  (($2::date) + 1)::timestamp AT TIME ZONE $3
        GROUP BY forma, origem ORDER BY SUM(valor) DESC`,
      [de, ate, fuso]
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao somar por forma de pagamento'); }
});

router.get('/por-hora', async (req, res) => {
  const [de, ate, fuso] = janela(req);
  try {
    const r = await query(
      `SELECT EXTRACT(HOUR FROM criado_em)::int AS hora, SUM(valor) AS bruto
         FROM pagamentos WHERE criado_em >= ($1::date)::timestamp AT TIME ZONE $3
          AND criado_em <  (($2::date) + 1)::timestamp AT TIME ZONE $3
        GROUP BY 1 ORDER BY 1`,
      [de, ate, fuso]
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao somar por hora'); }
});

router.get('/mais-vendidos', async (req, res) => {
  const [de, ate, fuso] = janela(req);
  try {
    const r = await query(
      `SELECT it.nome, SUM(it.quantidade)::int AS unidades,
              SUM(it.preco * it.quantidade) AS total
         FROM pedido_itens it JOIN pedidos p ON p.id = it.pedido_id
        WHERE p.status <> 'cancelado' AND p.criado_em >= ($1::date)::timestamp AT TIME ZONE $3
          AND criado_em <  (($2::date) + 1)::timestamp AT TIME ZONE $3
        GROUP BY it.nome ORDER BY unidades DESC LIMIT 10`,
      [de, ate, fuso]
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar os mais vendidos'); }
});

router.get('/transacoes', async (req, res) => {
  const [de, ate, fuso] = janela(req);
  try {
    const r = await query(
      `SELECT pg.*, m.numero AS mesa
         FROM pagamentos pg
         JOIN comandas c ON c.id = pg.comanda_id
         JOIN mesas m    ON m.id = c.mesa_id
        WHERE pg.criado_em >= ($1::date)::timestamp AT TIME ZONE $3
          AND criado_em <  (($2::date) + 1)::timestamp AT TIME ZONE $3
        ORDER BY pg.criado_em DESC LIMIT 100`,
      [de, ate, fuso]
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar as transações'); }
});

module.exports = { router };
