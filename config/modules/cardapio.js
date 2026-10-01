// Cardapio administrativo: categorias, adicionais e complementos.
//
// Nao e modulo opcional -- e nucleo. Fica em arquivo proprio so porque o
// Server.js ja estava grande, e produto/categoria/adicional sao o mesmo
// assunto.
//
// CATEGORIA continua sendo um texto na linha do produto, como sempre foi, e nao
// virou tabela. Transformar em tabela agora exigiria migrar os produtos
// existentes, inventar o que fazer com categoria vazia e reescrever o filtro
// que ja funciona -- em troca de nada que a tela precise hoje. Renomear uma
// categoria e um UPDATE nos produtos dela, que e o unico verbo que faltava.
const express = require('express');
const { query } = require('../server/dbConnection');

const router = express.Router();

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

// ------------------------------------------------------------ categorias
router.get('/categorias', async (req, res) => {
  try {
    const r = await query(
      `SELECT COALESCE(categoria, '') AS categoria, COUNT(*)::int AS produtos,
              COUNT(*) FILTER (WHERE disponivel)::int AS disponiveis
         FROM produtos GROUP BY 1 ORDER BY 1`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar as categorias'); }
});

router.put('/categorias/:nome', async (req, res) => {
  const novo = (req.body && req.body.nome ? String(req.body.nome) : '').trim();
  if (!novo) return res.status(400).json({ message: 'Informe o novo nome.' });
  try {
    const r = await query(
      'UPDATE produtos SET categoria = $2 WHERE COALESCE(categoria, $3) = $1',
      [req.params.nome, novo, '']
    );
    res.json({ renomeados: r.rowCount });
  } catch (e) { erro(res, e, 'Erro ao renomear a categoria'); }
});

// ----------------------------------------------------------- adicionais
router.get('/adicionais', async (req, res) => {
  try {
    const r = await query(
      `SELECT a.*, COUNT(pa.produto_id)::int AS produtos
         FROM adicionais a LEFT JOIN produto_adicionais pa ON pa.adicional_id = a.id
        GROUP BY a.id ORDER BY a.tipo, a.nome`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar os adicionais'); }
});

router.post('/adicionais', async (req, res) => {
  const { nome, preco, tipo } = req.body || {};
  if (!nome) return res.status(400).json({ message: 'Informe o nome.' });
  if (tipo && !['adicional', 'complemento'].includes(tipo)) {
    return res.status(400).json({ message: 'Tipo deve ser adicional ou complemento.' });
  }
  try {
    const r = await query(
      'INSERT INTO adicionais (nome, preco, tipo) VALUES ($1, $2, $3) RETURNING *',
      [String(nome).trim(), Number(preco || 0), tipo || 'adicional']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao criar o adicional'); }
});

router.patch('/adicionais/:id', async (req, res) => {
  const { nome, preco, ativo } = req.body || {};
  try {
    const r = await query(
      `UPDATE adicionais
          SET nome  = COALESCE($2, nome),
              preco = COALESCE($3, preco),
              ativo = COALESCE($4, ativo)
        WHERE id = $1 RETURNING *`,
      [Number(req.params.id),
       nome === undefined ? null : String(nome).trim(),
       preco === undefined ? null : Number(preco),
       ativo === undefined ? null : !!ativo]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Adicional não encontrado.' });
    res.json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao alterar o adicional'); }
});

router.delete('/adicionais/:id', async (req, res) => {
  try {
    const r = await query('DELETE FROM adicionais WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ message: 'Adicional não encontrado.' });
    // O que ja foi vendido nao se mexe: pedido_item_adicionais guarda nome e
    // preco congelados, e a chave la e ON DELETE SET NULL.
    res.json({ message: 'Adicional removido. Pedidos antigos continuam com o valor cobrado.' });
  } catch (e) { erro(res, e, 'Erro ao remover o adicional'); }
});

// Quais adicionais valem para um produto.
router.get('/produtos/:id/adicionais', async (req, res) => {
  try {
    const r = await query(
      `SELECT a.*, (pa.produto_id IS NOT NULL) AS vinculado
         FROM adicionais a
         LEFT JOIN produto_adicionais pa
                ON pa.adicional_id = a.id AND pa.produto_id = $1
        WHERE a.ativo ORDER BY a.tipo, a.nome`,
      [Number(req.params.id)]
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao carregar os adicionais do produto'); }
});

// Substitui a lista inteira, como a tela funciona (marca as caixas e salva).
router.put('/produtos/:id/adicionais', async (req, res) => {
  const ids = (req.body && req.body.adicionais) || [];
  if (!Array.isArray(ids)) return res.status(400).json({ message: 'Envie adicionais: [].' });
  const produtoId = Number(req.params.id);
  try {
    await query('DELETE FROM produto_adicionais WHERE produto_id = $1', [produtoId]);
    for (const id of ids) {
      await query(
        `INSERT INTO produto_adicionais (produto_id, adicional_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [produtoId, Number(id)]
      );
    }
    res.json({ vinculados: ids.length });
  } catch (e) { erro(res, e, 'Erro ao salvar os adicionais do produto'); }
});

module.exports = { router };
