// MODULO OPCIONAL: controle de estoque.
//
// Tres niveis, escolhidos em Configuracoes:
//   desligado   - nao faz nada. A disponibilidade e manual (produtos.disponivel).
//   simples     - conta unidades do prato pronto (produtos.quantidadeProduto).
//   ingrediente - baixa pela ficha tecnica, por ingrediente.
//
// Em todos os casos o resultado vai para a MESMA coluna que o modo manual usa:
// produtos.disponivel. O cardapio nao sabe se quem apagou o item foi o estoque
// ou o gerente -- e nao precisa saber.
//
// Este modulo nao e chamado pelo nucleo. Ele ESCUTA (pedido:liberado) e corrige
// o cardapio depois. Se ele estourar, o pedido ja entrou na cozinha do mesmo
// jeito; o pior caso e o estoque ficar desatualizado ate o proximo inventario.
const express = require('express');
const { query } = require('../server/dbConnection');
const cfg = require('../server/configuracoes');
const eventos = require('../server/eventos');

const router = express.Router();

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

// ------------------------------------------------------------- baixa
// sinal = -1 da baixa, +1 devolve (pedido cancelado).
async function movimenta(itens, pedidoId, sinal) {
  const modo = await cfg.ler('estoque.modo');
  if (modo === 'desligado') return;

  const tocados = [];
  for (const item of itens) {
    if (!item.produto_id) continue;
    tocados.push(item.produto_id);
    const qtd = Number(item.quantidade) * sinal;

    if (modo === 'simples') {
      // GREATEST(0, ...) porque a coluna tem CHECK >= 0: vender o ultimo prato
      // duas vezes por corrida nao pode derrubar a transacao do estoque.
      await query(
        `UPDATE produtos SET quantidadeProduto = GREATEST(0, quantidadeProduto + $2)
          WHERE idnomeProduto = $1`,
        [item.produto_id, qtd]
      );
      await query(
        `INSERT INTO estoque_mov (produto_id, tipo, quantidade, pedido_id, nota)
         VALUES ($1, $2, $3, $4, $5)`,
        [item.produto_id, sinal < 0 ? 'baixa' : 'ajuste', Math.abs(qtd), pedidoId,
         sinal < 0 ? 'baixa por pedido' : 'devolução por cancelamento']
      );
    }

    if (modo === 'ingrediente') {
      const ficha = await query(
        'SELECT ingrediente_id, quantidade FROM ficha_tecnica WHERE produto_id = $1',
        [item.produto_id]
      );
      // Produto sem ficha cadastrada nao da baixa -- e nao impede a venda.
      for (const linha of ficha.rows) {
        const usa = Number(linha.quantidade) * qtd;
        await query(
          'UPDATE ingredientes SET quantidade = quantidade + $2 WHERE id = $1',
          [linha.ingrediente_id, usa]
        );
        await query(
          `INSERT INTO estoque_mov (ingrediente_id, produto_id, tipo, quantidade, pedido_id, nota)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [linha.ingrediente_id, item.produto_id, sinal < 0 ? 'baixa' : 'ajuste',
           Math.abs(usa), pedidoId, sinal < 0 ? 'baixa por ficha técnica' : 'devolução']
        );
      }
    }
  }

  await recalculaDisponibilidade(tocados);
}

// Quem pode ser vendido agora.
//
// So reavalia os produtos PASSADOS por parametro -- os que acabaram de se mexer.
// A primeira versao varria a tabela inteira a cada baixa, e isso tem um efeito
// que ninguem pediu: ligar o modo simples escondia, de uma vez, todo produto com
// quantidade zero no cadastro, inclusive os que o gerente nunca quis controlar.
// Mexer so no que se moveu mantem o resto como a mao deixou.
async function recalculaDisponibilidade(produtoIds) {
  const modo = await cfg.ler('estoque.modo');
  const ids = (produtoIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;

  if (modo === 'simples') {
    await query(
      'UPDATE produtos SET disponivel = (quantidadeProduto > 0) WHERE idnomeProduto = ANY($1)',
      [ids]
    );
  }
  if (modo === 'ingrediente') {
    // Indisponivel quando QUALQUER ingrediente da ficha nao da para uma unidade.
    await query(
      `UPDATE produtos p SET disponivel = NOT EXISTS (
         SELECT 1 FROM ficha_tecnica f
           JOIN ingredientes i ON i.id = f.ingrediente_id
          WHERE f.produto_id = p.idnomeProduto AND i.quantidade < f.quantidade)
       WHERE p.idnomeProduto = ANY($1)
         AND EXISTS (SELECT 1 FROM ficha_tecnica f WHERE f.produto_id = p.idnomeProduto)`,
      [ids]
    );
  }
}

// Produtos afetados por um ingrediente -- usado quando chega mercadoria ou se
// registra perda: so as receitas que usam aquele insumo precisam ser reavaliadas.
async function produtosDoIngrediente(ingredienteId) {
  const r = await query('SELECT produto_id FROM ficha_tecnica WHERE ingrediente_id = $1', [ingredienteId]);
  return r.rows.map((l) => l.produto_id);
}

eventos.on('pedido:liberado', async ({ pedido, itens }) => {
  if (!(await cfg.moduloAtivo('estoque'))) return;
  await movimenta(itens, pedido.id, -1);
});

eventos.on('pedido:cancelado', async ({ pedido, itens }) => {
  if (!(await cfg.moduloAtivo('estoque'))) return;
  // So devolve o que chegou a sair: pedido cancelado antes de ir para a cozinha
  // nunca baixou nada.
  if (!pedido.liberado_em) return;
  await movimenta(itens, pedido.id, +1);
});

// ------------------------------------------------------------- rotas
router.get('/ingredientes', async (req, res) => {
  try {
    const r = await query(
      `SELECT *, (quantidade <= minimo) AS abaixo_do_minimo
         FROM ingredientes ORDER BY (quantidade <= minimo) DESC, nome`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar os ingredientes'); }
});

router.post('/ingredientes', async (req, res) => {
  const { nome, unidade, quantidade, minimo } = req.body || {};
  if (!nome) return res.status(400).json({ message: 'Informe o nome do ingrediente.' });
  try {
    const r = await query(
      `INSERT INTO ingredientes (nome, unidade, quantidade, minimo)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [nome, unidade || 'un', Number(quantidade || 0), Number(minimo || 0)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ message: 'Esse ingrediente já existe.' });
    erro(res, e, 'Erro ao cadastrar o ingrediente');
  }
});

// Entrada de nota fiscal, perda e ajuste de inventario passam pela mesma rota:
// o que muda e o tipo e o sinal. Tudo fica registrado em estoque_mov.
router.post('/ingredientes/:id/movimento', async (req, res) => {
  const { tipo, quantidade, nota } = req.body || {};
  if (!['entrada', 'perda', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ message: 'Tipo deve ser entrada, perda ou ajuste.' });
  }
  const qtd = Number(quantidade);
  if (!Number.isFinite(qtd) || qtd <= 0) {
    return res.status(400).json({ message: 'Quantidade deve ser maior que zero.' });
  }
  const sinal = tipo === 'entrada' ? 1 : -1;
  try {
    const r = await query(
      'UPDATE ingredientes SET quantidade = GREATEST(0, quantidade + $2) WHERE id = $1 RETURNING *',
      [Number(req.params.id), qtd * sinal]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Ingrediente não encontrado.' });
    await query(
      `INSERT INTO estoque_mov (ingrediente_id, tipo, quantidade, nota)
       VALUES ($1, $2, $3, $4)`,
      [Number(req.params.id), tipo, qtd, nota || null]
    );
    await recalculaDisponibilidade(await produtosDoIngrediente(Number(req.params.id)));
    res.status(201).json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao movimentar o estoque'); }
});

router.get('/ficha/:produtoId', async (req, res) => {
  try {
    const r = await query(
      `SELECT f.*, i.nome, i.unidade, i.quantidade AS em_estoque
         FROM ficha_tecnica f JOIN ingredientes i ON i.id = f.ingrediente_id
        WHERE f.produto_id = $1 ORDER BY i.nome`,
      [Number(req.params.produtoId)]
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao carregar a ficha técnica'); }
});

// Substitui a ficha inteira: e como a tela funciona (edita a lista e salva), e
// evita ficar com ingrediente orfao de uma versao anterior da receita.
router.put('/ficha/:produtoId', async (req, res) => {
  const linhas = req.body && req.body.itens;
  if (!Array.isArray(linhas)) return res.status(400).json({ message: 'Envie itens: [].' });
  const produtoId = Number(req.params.produtoId);
  try {
    await query('DELETE FROM ficha_tecnica WHERE produto_id = $1', [produtoId]);
    for (const l of linhas) {
      await query(
        `INSERT INTO ficha_tecnica (produto_id, ingrediente_id, quantidade) VALUES ($1, $2, $3)`,
        [produtoId, Number(l.ingrediente_id), Number(l.quantidade)]
      );
    }
    await recalculaDisponibilidade([produtoId]);
    res.json({ message: 'Ficha técnica salva.' });
  } catch (e) { erro(res, e, 'Erro ao salvar a ficha técnica'); }
});

router.get('/movimentos', async (req, res) => {
  try {
    const r = await query(
      `SELECT mv.*, i.nome AS ingrediente, p.nomeProduto AS produto
         FROM estoque_mov mv
         LEFT JOIN ingredientes i ON i.id = mv.ingrediente_id
         LEFT JOIN produtos p     ON p.idnomeProduto = mv.produto_id
        ORDER BY mv.criado_em DESC LIMIT 50`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar os movimentos'); }
});

module.exports = { router, recalculaDisponibilidade };
