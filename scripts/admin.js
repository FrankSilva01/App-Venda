// Cria ou redefine um administrador pelo terminal.
//
//   node scripts/admin.js criar  <login> <senha>
//   node scripts/admin.js senha  <login> <senha>
//   node scripts/admin.js listar
//
// Existe por um motivo pratico: a partir desta versao o painel exige login, e
// hash de senha nao se desfaz. Quem nao lembra a senha da instalacao antiga
// ficaria do lado de fora da propria casa sem um caminho pelo terminal -- e a
// alternativa seria uma senha de recuperacao escrita no codigo, que e pior.
//
// Roda na maquina do restaurante, onde quem tem acesso ao terminal ja tem
// acesso ao banco: nao abre porta nenhuma que ja nao estivesse aberta.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('../config/server/dbConnection');

const [, , acao, login, senha] = process.argv;

function uso(msg) {
  if (msg) console.error('\n' + msg);
  console.error(`
  node scripts/admin.js criar  <login> <senha>   cria um administrador
  node scripts/admin.js senha  <login> <senha>   redefine a senha
  node scripts/admin.js listar                   mostra os usuários
`);
  process.exit(1);
}

(async () => {
  if (acao === 'listar') {
    const r = await query(
      'SELECT id, login, nome, perfil, ativo FROM usuarios ORDER BY ativo DESC, login'
    );
    if (!r.rows.length) console.log('Nenhum usuário. A API está em modo instalação.');
    r.rows.forEach((u) => console.log(
      String(u.id).padStart(3) + '  ' + u.login.padEnd(18) +
      u.perfil.padEnd(9) + (u.ativo ? 'ativo' : 'desativado')
    ));
    return;
  }

  if (!login || !senha) uso('Informe login e senha.');
  if (String(senha).length < 6) uso('A senha precisa de ao menos 6 caracteres.');

  const hash = await bcrypt.hash(String(senha), 10);

  if (acao === 'criar') {
    try {
      const r = await query(
        `INSERT INTO usuarios (login, email, cpf, senha, perfil)
         VALUES ($1, $2, $3, $4, 'admin') RETURNING id, login, perfil`,
        [login, login + '@local', 'sem-cpf-' + Date.now(), hash]
      );
      console.log('Administrador criado:', r.rows[0].login);
    } catch (e) {
      if (e.code === '23505') uso('Esse login já existe. Use "senha" para redefinir.');
      throw e;
    }
    return;
  }

  if (acao === 'senha') {
    const r = await query(
      `UPDATE usuarios SET senha = $2, ativo = true WHERE login = $1 RETURNING id`, [login, hash]
    );
    if (!r.rows.length) uso('Login não encontrado. Use "criar".');
    // Trocar a senha derruba as sessoes abertas daquele usuario.
    await query('DELETE FROM sessoes WHERE usuario_id = $1', [r.rows[0].id]);
    console.log('Senha redefinida para', login);
    return;
  }

  uso();
})()
  .catch((e) => { console.error('Falhou:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
