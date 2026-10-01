// Usuarios e perfis.
//
// Substitui o cadastro publico que existia em /api/cadastrarUsuario: ali
// qualquer pessoa com o endereco da API criava uma conta. A rota antiga
// continua existindo, mas so funciona enquanto nao houver nenhum usuario (o
// primeiro administrador da instalacao) -- ver Server.js.
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../server/dbConnection');
const { PERFIS } = require('../server/auth');

const router = express.Router();
const CUSTO_BCRYPT = 10;

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

router.get('/', async (req, res) => {
  try {
    // A coluna `senha` nao sai daqui nunca, nem o hash: hash vazado e hash
    // que alguem vai tentar quebrar offline, com todo o tempo do mundo.
    const r = await query(
      `SELECT id, login, nome, email, perfil, ativo, criado_em
         FROM usuarios ORDER BY ativo DESC, login`
    );
    res.json({ usuarios: r.rows, perfis: Object.keys(PERFIS), areas: PERFIS });
  } catch (e) { erro(res, e, 'Erro ao listar os usuários'); }
});

router.post('/', async (req, res) => {
  const { login, nome, email, cpf, senha, perfil } = req.body || {};
  if (!login || !senha || !perfil) {
    return res.status(400).json({ message: 'Login, senha e perfil são obrigatórios.' });
  }
  if (!(perfil in PERFIS)) {
    return res.status(400).json({ message: 'Perfil inválido. Use: ' + Object.keys(PERFIS).join(', ') + '.' });
  }
  if (String(senha).length < 6) {
    return res.status(400).json({ message: 'A senha precisa de ao menos 6 caracteres.' });
  }
  try {
    const hash = await bcrypt.hash(String(senha), CUSTO_BCRYPT);
    const r = await query(
      `INSERT INTO usuarios (login, nome, email, cpf, senha, perfil)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, login, nome, email, perfil, ativo`,
      [login, nome || null,
       // email e cpf sao UNIQUE e NOT NULL desde a versao anterior. Funcionario
       // de salao raramente tem os dois a mao no momento do cadastro, entao
       // geramos um marcador -- trocar depois e um UPDATE.
       email || (login + '@local'), cpf || ('sem-cpf-' + Date.now()),
       hash, perfil]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ message: 'Login, e-mail ou CPF já cadastrado.' });
    }
    erro(res, e, 'Erro ao criar o usuário');
  }
});

router.patch('/:id', async (req, res) => {
  const { nome, email, perfil, ativo } = req.body || {};
  if (perfil && !(perfil in PERFIS)) {
    return res.status(400).json({ message: 'Perfil inválido.' });
  }
  const id = Number(req.params.id);
  try {
    // Ninguem pode se rebaixar nem se desativar: a instalacao ficaria sem
    // ninguem capaz de arrumar, e so restaria mexer no banco a mao.
    if (req.usuario && req.usuario.id === id && (perfil || ativo === false)) {
      return res.status(409).json({ message: 'Você não pode mudar o próprio perfil nem se desativar.' });
    }
    // Da mesma forma, nao da para desligar o ultimo administrador ativo.
    if (ativo === false || (perfil && perfil !== 'admin')) {
      const adm = await query(
        "SELECT COUNT(*)::int AS n FROM usuarios WHERE ativo AND perfil = 'admin' AND id <> $1", [id]
      );
      const alvo = await query('SELECT perfil, ativo FROM usuarios WHERE id = $1', [id]);
      if (alvo.rows.length && alvo.rows[0].perfil === 'admin' && alvo.rows[0].ativo && !adm.rows[0].n) {
        return res.status(409).json({ message: 'Este é o último administrador ativo.' });
      }
    }

    const r = await query(
      `UPDATE usuarios
          SET nome   = COALESCE($2, nome),
              email  = COALESCE($3, email),
              perfil = COALESCE($4, perfil),
              ativo  = COALESCE($5, ativo)
        WHERE id = $1
        RETURNING id, login, nome, email, perfil, ativo`,
      [id, nome === undefined ? null : nome, email === undefined ? null : email,
       perfil || null, ativo === undefined ? null : !!ativo]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Usuário não encontrado.' });

    // Desativar derruba as sessoes abertas na hora. Sem isto, quem foi desligado
    // continua com o painel na mao ate a sessao vencer.
    if (ativo === false) await query('DELETE FROM sessoes WHERE usuario_id = $1', [id]);

    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ message: 'E-mail já cadastrado.' });
    erro(res, e, 'Erro ao alterar o usuário');
  }
});

// Redefinir senha: o administrador define uma nova, nao descobre a atual. Hash
// nao se desfaz -- isso nao mudou.
router.post('/:id/senha', async (req, res) => {
  const { senha } = req.body || {};
  if (!senha || String(senha).length < 6) {
    return res.status(400).json({ message: 'A senha precisa de ao menos 6 caracteres.' });
  }
  try {
    const hash = await bcrypt.hash(String(senha), CUSTO_BCRYPT);
    const r = await query('UPDATE usuarios SET senha = $2 WHERE id = $1 RETURNING id', [
      Number(req.params.id), hash,
    ]);
    if (!r.rows.length) return res.status(404).json({ message: 'Usuário não encontrado.' });
    // Trocar a senha encerra as sessoes daquele usuario: e o que se espera de
    // "redefinir senha" quando o motivo foi justamente alguem ter acesso.
    await query('DELETE FROM sessoes WHERE usuario_id = $1', [Number(req.params.id)]);
    res.json({ message: 'Senha redefinida. As sessões abertas foram encerradas.' });
  } catch (e) { erro(res, e, 'Erro ao redefinir a senha'); }
});

module.exports = { router };
