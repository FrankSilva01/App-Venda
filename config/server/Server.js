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

const bcrypt = require('bcryptjs');

const { query } = require('./dbConnection');
const upload = require('../MulterConfig');

// Composicao: e AQUI que o produto é montado, e so aqui. O nucleo nao conhece
// os modulos; este arquivo conhece os quatro e decide quem entra.
const cfg = require('./configuracoes');
const fluxo = require('../modules/fluxo');
const pagamento = require('../modules/pagamento');
const estoque = require('../modules/estoque');
const financeiro = require('../modules/financeiro');

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

// Liga e desliga o item no cardapio. E o controle de disponibilidade do modo
// SEM estoque -- e continua valendo com o estoque ligado, para o gerente poder
// tirar do ar um prato que tem insumo mas acabou de queimar.
app.patch('/produtos/:id/disponibilidade', async (req, res) => {
  const { disponivel } = req.body || {};
  if (typeof disponivel !== 'boolean') {
    return res.status(400).json({ message: 'Envie disponivel: true ou false.' });
  }
  try {
    const r = await query(
      'UPDATE produtos SET disponivel = $2 WHERE idnomeProduto = $1 RETURNING *',
      [Number(req.params.id), disponivel]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    erro(res, e, 'Erro ao mudar a disponibilidade');
  }
});

// ---------------------------------------------------------------- usuarios
// Custo 10: ~100 ms por verificacao nesta maquina. E lento DE PROPOSITO -- e o
// que torna caro testar milhoes de senhas se o banco vazar. Subir o numero dobra
// o tempo a cada ponto.
const CUSTO_BCRYPT = 10;

// Hash DE VERDADE, de uma senha aleatoria que ninguem conhece, so para o login
// de usuario inexistente gastar o mesmo tempo do que existe.
//
// A primeira tentativa usou uma string inventada no formato do bcrypt. Nao
// funcionou: hash malformado e recusado na hora, sem calcular nada, e a medicao
// mostrou 7 ms contra 60 ms -- ou seja, o tempo de resposta continuava dizendo
// quais logins existem. So um hash valido obriga o bcrypt a fazer o trabalho.
const HASH_FALSO = bcrypt.hashSync(
  Math.random().toString(36) + Date.now(), CUSTO_BCRYPT);

app.post('/api/cadastrarUsuario', async (req, res) => {
  const { login, email, senha, cpf } = req.body;
  if (!login || !email || !senha || !cpf) {
    return res.status(400).json({ message: 'Todos os campos devem ser preenchidos.' });
  }
  if (String(senha).length < 6) {
    return res.status(400).json({ message: 'A senha precisa de ao menos 6 caracteres.' });
  }
  try {
    const hash = await bcrypt.hash(String(senha), CUSTO_BCRYPT);
    const r = await query(
      'INSERT INTO usuarios (login, email, senha, cpf) VALUES ($1, $2, $3, $4) RETURNING id',
      [login, email, hash, cpf]
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

// POST e nao GET: a senha ia na QUERYSTRING, e querystring fica no historico do
// navegador, no Referer e no log de qualquer proxy pelo caminho. No corpo, nao.
app.post('/api/login', async (req, res) => {
  const { login, senha } = req.body || {};
  if (!login || !senha) return res.status(400).json({ message: 'Informe login e senha.' });
  try {
    const r = await query(
      'SELECT id, login, email, cpf, senha FROM usuarios WHERE login = $1',
      [login]
    );
    const u = r.rows[0];
    // bcrypt.compare mesmo sem usuario: responder na hora quando o login nao
    // existe revela QUAIS logins existem, pelo tempo da resposta.
    const confere = await bcrypt.compare(String(senha), u ? u.senha : HASH_FALSO);
    if (!u || !confere) {
      // Uma mensagem so para os dois casos, pela mesma razao.
      return res.status(401).json({ message: 'Login ou senha não conferem.' });
    }
    res.json({ id: u.id, login: u.login, email: u.email, cpf: u.cpf });
  } catch (e) {
    erro(res, e, 'Erro ao verificar os dados de login');
  }
});

// A rota antiga recebia a senha pela URL. Fica avisando, para quem tiver codigo
// velho apontando para ela descobrir o porque em vez de ver um 404 silencioso.
app.get('/api/usuarios', (req, res) => {
  res.status(410).json({
    message: 'Removida: a senha ia na URL. Use POST /api/login com login e senha no corpo.'
  });
});

// ------------------------------------------------ configuracao e modulos
// A configuracao e do nucleo: e a tela que liga e desliga os modulos, entao ela
// nao pode morar dentro de nenhum deles.
app.get('/api/configuracoes', async (req, res) => {
  try {
    res.json(await cfg.todas());
  } catch (e) { erro(res, e, 'Erro ao ler as configurações'); }
});

app.put('/api/configuracoes', async (req, res) => {
  try {
    res.json(await cfg.salvar(req.body || {}));
  } catch (e) {
    // Combinacao impossivel ou valor fora da lista e 400: e o usuario pedindo
    // algo que nao existe, nao a API quebrando.
    if (/inválid|desconhecida|exige|entre 0 e 100/i.test(e.message)) {
      return res.status(400).json({ message: e.message });
    }
    erro(res, e, 'Erro ao salvar as configurações');
  }
});

// O nucleo esta sempre no ar.
app.use('/api', fluxo.router);

// Os modulos tambem sao montados sempre -- quem decide e o middleware, a cada
// requisicao. Montar so no boot obrigaria a reiniciar a API para ligar um
// modulo, e a tela de Configuracoes promete o contrario.
function exigeModulo(nome) {
  return async (req, res, next) => {
    try {
      if (await cfg.moduloAtivo(nome)) return next();
      // 409 e nao 404: a rota existe, o estabelecimento e que nao a habilitou.
      res.status(409).json({
        message: 'Módulo ' + nome + ' está desligado para este estabelecimento.',
        modulo: nome,
      });
    } catch (e) { next(e); }
  };
}

app.use('/api/pagamento', exigeModulo('pagamento'), pagamento.router);
app.use('/api/estoque', exigeModulo('estoque'), estoque.router);
app.use('/api/financeiro', exigeModulo('financeiro'), financeiro.router);

// Para saber se a API esta de pe sem precisar de banco com dado dentro.
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    // Em try separado: instalacao com o banco de pe mas sem `npm run schema`
    // ainda deve responder ok e dizer o que falta, em vez de 503.
    let configuracao = null;
    try { configuracao = await cfg.todas(); } catch (e) { configuracao = { erro: e.message }; }
    res.json({ ok: true, banco: 'postgres', configuracao });
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
