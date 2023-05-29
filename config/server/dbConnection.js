const mysql = require('mysql2');

// Configuração da conexão com o banco de dados
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '123456',
  database: 'app_praia',
});

// Conectar ao banco de dados
connection.connect((error) => {
  if (error) {
    console.error('Erro ao conectar ao banco de dados:', error);
    return;
  }
  console.log('Conexão bem-sucedida ao banco de dados!');
});

module.exports = connection;
