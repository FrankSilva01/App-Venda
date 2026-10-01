// API do App-Venda.
//
// Convertido de MySQL para PostgreSQL. Tres mudancas que atravessam o arquivo:
//   - os marcadores viraram $1, $2... (no mysql2 eram ?);
//   - INSERT ganha RETURNING, porque o pg nao devolve insertId;
//   - credenciais sairam do codigo e vieram do .env (ver dbConnection.js).
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const { query } = require('./dbConnection');
const upload = require('../MulterConfig');

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// A MESMA pasta em que o Multer grava -- vem de la para as duas pontas nao
// poderem divergir de novo.
app.use('/upload', express.static(upload.PASTA_UPLOADS));

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

// ---------------------------------------------------------------- produtos
app.post('/api/cadastrarProduto', upload.single('imagemProduto'), async (req, res) => {
  const { nomeProduto, precoProduto, descricaoProduto, quantidadeProduto, categoria } = req.body;
  if (!nomeProduto || !precoProduto || !descricaoProduto || !quantidadeProduto || !categoria || !req.file) {
    return res.status(400).json({ message: 'Todos os campos devem ser preenchidos.' });
  }
  try {
    const r = await query(
      `INSERT INTO produtos
         (nomeProduto, precoProduto, descricaoProduto, imagemProduto, quantidadeProduto, categoria)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING idnomeProduto`,
      [nomeProduto, precoProduto, descricaoProduto, req.file.filename, quantidadeProduto, categoria]
    );
    res.status(201).json({ id: r.rows[0].idnomeproduto, message: 'Produto cadastrado com sucesso' });
  } catch (e) {
    erro(res, e, 'Erro ao cadastrar o produto');
  }
});

app.get('/produtos', async (req, res) => {
  // Filtro por categoria: era um item do Etapas.txt ("puxar somente as bebidas")
  // e sai de graca aqui, em vez de buscar tudo e filtrar no navegador.
  const { categoria } = req.query;
  try {
    const r = categoria
      ? await query('SELECT * FROM produtos WHERE categoria = $1 ORDER BY nomeProduto', [categoria])
      : await query('SELECT * FROM produtos ORDER BY nomeProduto');
    res.json(r.rows);
  } catch (e) {
    erro(res, e, 'Erro ao obter os produtos');
  }
});

app.delete('/produtos/:idnomeProduto', async (req, res) => {
  try {
    const r = await query('DELETE FROM produtos WHERE idnomeProduto = $1', [req.params.idnomeProduto]);
    if (!r.rowCount) return res.status(404).json({ message: 'Produto não encontrado' });
    res.json({ message: 'Produto removido' });
  } catch (e) {
    erro(res, e, 'Erro ao deletar o produto');
  }
});

// ---------------------------------------------------------------- usuarios
app.post('/api/cadastrarUsuario', async (req, res) => {
  const { login, email, senha, cpf } = req.body;
  if (!login || !email || !senha || !cpf) {
    return res.status(400).json({ message: 'Todos os campos devem ser preenchidos.' });
  }
  try {
    const r = await query(
      'INSERT INTO usuarios (login, email, senha, cpf) VALUES ($1, $2, $3, $4) RETURNING id',
      [login, email, senha, cpf]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    // 23505 = violacao de UNIQUE. Era um item do Etapas.txt: avisar que o login,
    // o CPF ou o e-mail ja existem, em vez de estourar 500.
    if (e.code === '23505') {
      return res.status(409).json({ message: 'Login, e-mail ou CPF já cadastrado.' });
    }
    erro(res, e, 'Erro ao cadastrar o usuário');
  }
});

app.get('/api/usuarios', async (req, res) => {
  const { login, senha } = req.query;
  if (!login || !senha) return res.status(400).json({ error: 'Informe login e senha.' });
  try {
    // Sem SELECT *: a senha nao volta na resposta, nem para quem acertou.
    const r = await query(
      'SELECT id, login, email, cpf FROM usuarios WHERE login = $1 AND senha = $2',
      [login, senha]
    );
    res.json(r.rows);
  } catch (e) {
    erro(res, e, 'Erro ao verificar os dados de login');
  }
});

// Para saber se a API esta de pe sem precisar de banco com dado dentro.
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, banco: 'postgres' });
  } catch (e) {
    res.status(503).json({ ok: false, erro: e.message });
  }
});

// Falha de upload (nao e imagem, passou de 5 MB) chega aqui como erro do Multer.
// Sem este handler o Express devolve uma pagina HTML de erro -- o front espera JSON.
app.use((err, req, res, next) => {
  if (err && err.message) {
    console.error('Falha na requisicao:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

app.listen(port, () => {
  console.log('API do App-Venda na porta ' + port);
});

module.exports = app;
