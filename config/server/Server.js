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
const auth = require('./auth');
const fluxo = require('../modules/fluxo');
const cardapio = require('../modules/cardapio');
const usuarios = require('../modules/usuarios');
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

// As telas tambem saem daqui, pela MESMA origem da API.
//
// O GitHub Pages serve em HTTPS, e a API do restaurante roda em HTTP na rede
// local. O navegador bloqueia chamada HTTP dentro de pagina HTTPS -- a unica
// excecao e localhost, que e o proprio aparelho. Por isso o celular do cliente
// abria o cardapio do Pages e falhava em TODA chamada: para ele, localhost e o
// celular, e o IP da casa e HTTP dentro de HTTPS.
//
// Servindo daqui, o QR aponta para http://<ip-da-maquina>:3001/mesa.html e o
// celular fala com a API na mesma origem: sem mistura de protocolo e sem CORS.
// O Pages continua valendo como vitrine e para quem usa a API em localhost.
//
// express.static so responde por arquivo que existe, entao nao atrapalha
// nenhuma rota da API.
//
// no-cache NAO quer dizer "nao guarde": quer dizer "pergunte antes de usar".
// O navegador continua guardando e o servidor responde 304 quando nada mudou --
// de graca numa rede local. Sem isso, atualizar o sistema deixa celular e
// tablet rodando a tela antiga por tempo indeterminado, e o sintoma ("aqui nao
// mudou nada") nao aponta para o cache.
app.use(express.static(path.join(__dirname, '..', '..', 'docs'), {
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Enderecos pelos quais esta maquina pode ser alcancada na rede. O instalador
// nao tem como adivinhar o IP, e errar aqui so aparece com o adesivo ja colado
// na mesa.
app.get('/api/rede', (req, res) => {
  const os = require('os');
  const faixas = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((nome) => {
    (ifaces[nome] || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) faixas.push({ interface: nome, ip: i.address });
    });
  });
  res.json({
    porta: port,
    enderecos: faixas.map((f) => Object.assign(f, {
      base: 'http://' + f.ip + ':' + port,
      cliente: 'http://' + f.ip + ':' + port + '/mesa.html',
    })),
  });
});

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

// ---------------------------------------------------------------- produtos
app.post('/api/cadastrarProduto', auth.exigeSessao('cardapio'), upload.single('imagemProduto'), async (req, res) => {
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

app.delete('/produtos/:idnomeProduto', auth.exigeSessao('cardapio'), async (req, res) => {
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
app.patch('/produtos/:id/disponibilidade', auth.exigeSessao('cardapio'), async (req, res) => {
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

// Era cadastro PUBLICO: qualquer um com o endereco da API criava conta. Agora
// so funciona enquanto a instalacao nao tem nenhum usuario -- e o primeiro
// administrador, que nasce com perfil admin. Depois disso quem cria conta e o
// administrador, em /api/usuarios.
app.post('/api/cadastrarUsuario', async (req, res) => {
  if (!(await auth.modoInstalacao())) {
    return res.status(409).json({
      message: 'O cadastro público está fechado. Peça a um administrador para criar seu usuário.',
    });
  }
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
// Login. Agora devolve TOKEN DE SESSAO e perfil -- antes so dizia "confere" e
// o painel acreditava, sem nada no servidor sabendo quem estava logado.
app.post('/api/login', async (req, res) => {
  const { login, senha } = req.body || {};
  if (!login || !senha) return res.status(400).json({ message: 'Informe login e senha.' });
  try {
    const sessao = await auth.entrar(login, senha);
    // Login inexistente, senha errada e usuario desativado dao a MESMA resposta.
    // Diferenciar entrega quais logins existem e quem foi desligado.
    if (!sessao) return res.status(401).json({ message: 'Login ou senha não conferem.' });
    res.json(sessao);
  } catch (e) {
    erro(res, e, 'Erro ao verificar os dados de login');
  }
});

// Quem sou eu: o painel chama no boot para saber se a sessao guardada ainda
// vale e quais areas desenhar no menu.
app.get('/api/sessao', async (req, res) => {
  try {
    const instalacao = await auth.modoInstalacao();
    const u = await auth.daSessao((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!u) return res.status(401).json({ message: 'Sem sessão.', instalacao });
    res.json({ usuario: u, areas: auth.PERFIS[u.perfil] || [], instalacao: false });
  } catch (e) { erro(res, e, 'Erro ao conferir a sessão'); }
});

app.delete('/api/sessao', async (req, res) => {
  try {
    await auth.sair((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    res.json({ message: 'Sessão encerrada.' });
  } catch (e) { erro(res, e, 'Erro ao sair'); }
});

// ------------------------------------------------ configuracao e modulos
// A configuracao e do nucleo: e a tela que liga e desliga os modulos, entao ela
// nao pode morar dentro de nenhum deles.
// Leitura aberta: a tela do cliente precisa saber se mostra "pagar agora" e
// como se chama a casa. Sao decisoes de interface, nao segredo.
app.get('/api/configuracoes', async (req, res) => {
  try {
    res.json(await cfg.todas());
  } catch (e) { erro(res, e, 'Erro ao ler as configurações'); }
});

app.put('/api/configuracoes', auth.exigeSessao('config'), async (req, res) => {
  try {
    res.json(await cfg.salvar(req.body || {}));
  } catch (e) {
    // Combinacao impossivel ou valor fora da lista e 400: e o usuario pedindo
    // algo que nao existe, nao a API quebrando. A marca vem de configuracoes.js.
    if (e.validacao) return res.status(400).json({ message: e.message });
    erro(res, e, 'Erro ao salvar as configurações');
  }
});

// ------------------------------------------------------------ permissao
// As rotas do NUCLEO sao montadas em dois grupos:
//
//   a) o que o cliente da mesa usa (tudo sob /api/qr/:token e a criacao de
//      pedido) fica aberto -- o token do QR e a credencial dele;
//   b) o resto exige sessao, cada rota com a area do perfil que a enxerga.
//
// A ordem importa: express casa a primeira que bater, entao os middlewares de
// area vem ANTES do router do fluxo.
app.use('/api/qr', auth.identifica);

// Criar pedido e o unico verbo compartilhado: o cliente faz pelo token, o
// garcom faz logado. `identifica` carimba quem foi sem barrar ninguem.
app.post('/api/pedidos', auth.identifica);

[['/api/salao', 'salao'],
 ['/api/chamados', 'salao'],
 ['/api/mesas', 'mesas'],
 ['/api/mesa', 'salao'],
 ['/api/cozinha', 'cozinha'],
 ['/api/stream', null]].forEach(([caminho, area]) => app.use(caminho, auth.exigeSessao(area)));

// Mudar etapa do pedido e cancelar: basta estar logado (a cozinha avanca, o
// garcom entrega, o caixa cancela).
app.use('/api/pedidos/:id', auth.exigeSessao());

// A comanda e dos dois lados, e por isso nao da para resolver com uma area so:
// LER a conta o garcom precisa ("quanto deu?"), mas lancar pagamento, mexer no
// serviço e fechar e do caixa.
app.use('/api/comandas', (req, res, next) => {
  const soLeitura = req.method === 'GET' && /^\/\d+(\/historico)?$/.test(req.path);
  return auth.exigeSessao(soLeitura ? ['caixa', 'salao'] : 'caixa')(req, res, next);
});

// O nucleo esta sempre no ar.
app.use('/api', fluxo.router);
app.use('/api/cardapio', auth.exigeSessao('cardapio'), cardapio.router);
app.use('/api/usuarios', auth.exigeSessao('usuarios'), usuarios.router);

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

// Pagar pelo app e do cliente (token do QR) e tambem do caixa: so identifica.
app.use('/api/pagamento', auth.identifica, exigeModulo('pagamento'), pagamento.router);
app.use('/api/estoque', auth.exigeSessao('cardapio'), exigeModulo('estoque'), estoque.router);
app.use('/api/financeiro', auth.exigeSessao('relatorios'), exigeModulo('financeiro'), financeiro.router);

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
  auth.limpaSessoes();
  // Uma vez por dia basta: sessao vencida nao autentica ninguem, a limpeza e so
  // para a tabela nao crescer para sempre. unref() para o timer nao segurar o
  // processo no ar quando alguem derrubar a API.
  setInterval(auth.limpaSessoes, 24 * 3600 * 1000).unref();
});

module.exports = app;
