// Login, sessao e permissao por perfil.
//
// Ate aqui a API era aberta: quem alcancasse a porta 3001 fechava uma mesa ou
// revogava um QR. Este arquivo fecha isso.
//
// Sessao em TABELA, nao JWT assinado. Com JWT, desativar um funcionario so tem
// efeito quando o token vence -- e nao ha como revogar sem manter uma lista, que
// e exatamente a tabela que o JWT queria evitar. Aqui, DELETE na linha e o
// acesso morre na proxima requisicao.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./dbConnection');

const DIAS = 7;

// Hash DE VERDADE, de uma senha aleatoria que ninguem conhece, so para o login
// de usuario inexistente custar o mesmo tempo do que existe. Hash inventado no
// formato do bcrypt nao serve: e recusado na hora, sem calcular nada, e a
// medicao mostrava 7 ms contra 60 ms -- o tempo da resposta continuava dizendo
// quais logins existem.
const HASH_FALSO = bcrypt.hashSync(Math.random().toString(36) + Date.now(), 10);

// Quem enxerga o que. O cliente na mesa nao entra nesta tabela: ele nao tem
// conta, entra pelo token do QR.
const PERFIS = {
  admin:   ['salao', 'cozinha', 'caixa', 'cardapio', 'mesas', 'relatorios', 'usuarios', 'config'],
  gerente: ['salao', 'cozinha', 'caixa', 'cardapio', 'mesas', 'relatorios', 'config'],
  garcom:  ['salao'],
  cozinha: ['cozinha'],
  caixa:   ['salao', 'caixa'],
};

function podeVer(perfil, area) {
  return (PERFIS[perfil] || []).indexOf(area) >= 0;
}

// Enquanto NAO existir nenhum usuario ativo, a API aceita tudo sem login e
// libera a criacao do primeiro administrador. E a unica forma de uma instalacao
// nova sair do zero sem senha escrita no codigo. Assim que o primeiro usuario
// existe, o modo se fecha sozinho -- ninguem precisa lembrar de desligar.
async function modoInstalacao() {
  const r = await query('SELECT COUNT(*)::int AS n FROM usuarios WHERE ativo');
  return r.rows[0].n === 0;
}

async function entrar(login, senha) {
  const r = await query(
    'SELECT id, login, nome, email, perfil, ativo, senha FROM usuarios WHERE login = $1',
    [login]
  );
  const u = r.rows[0];
  // Compara mesmo sem usuario: responder na hora quando o login nao existe
  // revela QUAIS logins existem, pelo tempo da resposta.
  const confere = await bcrypt.compare(String(senha), u ? u.senha : HASH_FALSO);
  if (!u || !confere || !u.ativo) return null;

  const token = crypto.randomBytes(24).toString('base64url');
  const expira = new Date(Date.now() + DIAS * 24 * 3600 * 1000);
  await query('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, $3)',
    [token, u.id, expira]);

  return {
    token,
    expira_em: expira,
    usuario: { id: u.id, login: u.login, nome: u.nome, email: u.email, perfil: u.perfil },
    areas: PERFIS[u.perfil] || [],
  };
}

async function sair(token) {
  await query('DELETE FROM sessoes WHERE token = $1', [token]);
}

async function daSessao(token) {
  if (!token) return null;
  const r = await query(
    `SELECT u.id, u.login, u.nome, u.email, u.perfil
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = $1 AND s.expira_em > now() AND u.ativo`,
    [token]
  );
  return r.rows[0] || null;
}

function tokenDoPedido(req) {
  const h = req.headers.authorization || '';
  return h.replace(/^Bearer\s+/i, '') || null;
}

// Middleware. `area` pode ser:
//   undefined/null  - basta estar logado;
//   'caixa'         - precisa daquela area;
//   ['caixa','salao'] - qualquer uma das duas serve.
//
// A lista existe porque algumas telas sao compartilhadas: a conta da mesa e do
// caixa, mas o garcom tambem precisa ver para responder "quanto deu?".
//
// Nao devolve 403 generico: a mensagem diz QUAL perfil faltou, porque o erro
// mais comum em operacao e o garcom abrindo o caixa e achando que o sistema
// quebrou.
function exigeSessao(area) {
  const areas = area == null ? [] : (Array.isArray(area) ? area : [area]);
  return async (req, res, next) => {
    try {
      if (await modoInstalacao()) {
        req.usuario = null;
        req.instalacao = true;
        return next();
      }
      const u = await daSessao(tokenDoPedido(req));
      if (!u) return res.status(401).json({ message: 'Faça login para continuar.', login: true });
      if (areas.length && !areas.some((a) => podeVer(u.perfil, a))) {
        return res.status(403).json({
          message: 'Seu perfil (' + u.perfil + ') não tem acesso a ' + areas.join(' ou ') + '.',
        });
      }
      req.usuario = u;
      next();
    } catch (e) { next(e); }
  };
}

// Identifica quem esta pedindo SEM barrar. Usado nas rotas que o cliente da
// mesa tambem usa: serve so para carimbar quem foi, quando foi um funcionario.
async function identifica(req, res, next) {
  try {
    req.usuario = await daSessao(tokenDoPedido(req));
  } catch (e) {
    req.usuario = null;
  }
  next();
}

// Sessao vencida nao serve para nada e a tabela so cresce. Limpa no boot e uma
// vez por dia -- nao vale um agendador para isso.
async function limpaSessoes() {
  try { await query('DELETE FROM sessoes WHERE expira_em < now()'); }
  catch (e) { console.error('Falha ao limpar sessões:', e.message); }
}

module.exports = {
  PERFIS, podeVer, modoInstalacao, entrar, sair, daSessao,
  exigeSessao, identifica, limpaSessoes,
};
