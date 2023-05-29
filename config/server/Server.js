const express = require('express');
const app = express();
const mysql = require('mysql2');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const port = 3001;

// Configuração do Multer para o upload da imagem
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Usar o nome original do arquivo
  },
});

const upload = multer({ storage });

// Configuração do MySQL
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '123456',
  database: 'app_praia',
});

connection.connect((err) => {
  if (err) {
    console.error('Erro ao conectar ao MySQL: ' + err.stack);
    return;
  }
  console.log('Conexão bem-sucedida ao MySQL com o ID: ' + connection.threadId);
});

app.use(cors());
app.use(express.json());
app.use('/upload', express.static(path.join(__dirname, 'uploads')));

// Rota para receber o formulário de cadastro e salvar no banco de dados
app.post('/api/cadastrarProduto', upload.single('imagemProduto'), (req, res) => {
  console.log(req.body);
  const { nomeProduto, precoProduto, descricaoProduto, quantidadeProduto, categoria } = req.body;
  const imagemProduto = req.file.filename;

  if (!nomeProduto || !precoProduto || !descricaoProduto || !quantidadeProduto || !categoria || !req.file) {
    res.status(400).json({ message: 'Todos os campos devem ser preenchidos.' });
    return;
  }


  const sql = 'INSERT INTO produtos (nomeProduto, precoProduto, descricaoProduto, imagemProduto, quantidadeProduto, categoria) VALUES (?, ?, ?, ?, ?, ?)';
  const values = [nomeProduto, precoProduto, descricaoProduto, imagemProduto, quantidadeProduto, categoria];

  connection.query(sql, values, (err, result) => {
    if (err) {
      console.error('Erro ao cadastrar o produto: ' + err);
      res.sendStatus(500);
      return;
    }

    res.sendStatus(200);
  });
});

// Rota para cadastrar o usuário
app.post('/api/cadastrarUsuario', (req, res) => {
  const { login, email, senha, cpf } = req.body;
  const sql = 'INSERT INTO usuarios (login, email, senha, cpf) VALUES (?, ?, ?, ?)';
  const values = [login, email, senha, cpf];

  connection.query(sql, values, (error, results) => {
    if (error) {
      console.error('Erro ao cadastrar o usuário: ' + error);
      res.sendStatus(500);
      return;
    }
    res.sendStatus(200);
  });
});

app.get('/api/usuarios', (req, res) => {
  const {login, senha} = req.query
  values = 'SELECT * FROM usuarios WHERE login = ? AND senha = ?'

  connection.query(values,  [login,senha], (err, results) => {
    if (err) {
      console.error('Erro ao verificar os dados de login: ' + err.message);
      res.status(500).json({ error: 'Erro ao obter o usuario' });
    } else {
      res.json(results);
    }
  });
});

app.get('/produtos', (req, res) => {
  const query = 'SELECT * FROM produtos';

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Erro ao obter os produtos:', error);
      res.status(500).json({ error: 'Erro ao obter os produtos' });
    } else {
      res.json(results);
    }
  });
});

// Rota para deletar um produto pelo ID
app.delete('/produtos/:idnomeProduto', (req, res) => {
  const { idnomeProduto } = req.params;

  const sql = 'DELETE FROM produtos WHERE idnomeProduto = ?';

  connection.query(sql, [idnomeProduto], (err, result) => {
    if (err) {
      console.error('Erro ao deletar o produto: ' + err);
      res.sendStatus(500);
      return;
    }

    res.sendStatus(200);
  });
});

app.listen(port, () => {
  console.log('Servidor rodando na porta ' + port);
});


module.exports = connection