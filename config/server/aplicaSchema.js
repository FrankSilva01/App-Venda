// Cria as tabelas. `npm run schema`.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./dbConnection');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Schema aplicado em', process.env.PGDATABASE || 'lab');
  } catch (e) {
    console.error('Falhou:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
