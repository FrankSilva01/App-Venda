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

// Transacao. Um pedido e o pedido + seus itens: gravar metade e falhar deixaria
// comanda com pedido fantasma de total zero. O cliente recebe a conexao e usa
// cliente.query normalmente; COMMIT e ROLLBACK ficam por conta daqui.
async function transacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    // Sem release a conexao nunca volta para o pool e, depois de 10 pedidos com
    // erro, a API inteira trava esperando conexao livre.
    cliente.release();
  }
}

module.exports = { pool, query, transacao };
