// Conexao com o PostgreSQL.
//
// Era MySQL com host, usuario e senha escritos no arquivo -- e o arquivo esta num
// repositorio publico. Agora tudo vem do ambiente (.env, que o .gitignore barra).
//
// Pool e nao Connection: uma conexao unica cai em qualquer hiccup de rede e so
// volta reiniciando o processo; o pool reconecta sozinho e aguenta requisicao
// simultanea, que e o caso de qualquer API.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'lab',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Erro em conexao ociosa do pool. Sem este handler o Node derruba o processo.
  console.error('Erro inesperado no pool do Postgres:', err.message);
});

// Ponte para o codigo que ja existia, escrito no estilo do mysql2:
//   connection.query(sql, valores, (err, results) => ...)
// No pg o retorno e um objeto e as linhas ficam em .rows. Traduzir aqui evita
// reescrever cada rota e, principalmente, evita o erro silencioso de devolver o
// objeto inteiro no lugar das linhas.
function query(sql, valores, cb) {
  if (typeof valores === 'function') {
    cb = valores;
    valores = [];
  }
  return pool
    .query(sql, valores)
    .then((r) => (cb ? cb(null, r.rows, r) : r))
    .catch((e) => {
      if (!cb) throw e;
      cb(e);
    });
}

module.exports = { pool, query };
