const express = require('express');
const router = express.Router();
const connection = require('../server/dbConnection');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' }); // Define o diretório de destino dos uploads

router.post('/upload', upload.single('imagemProduto'), (req, res) => {
    // Lógica para salvar o arquivo e processar os dados do formulário
    const { nomeProduto, precoProduto, descricaoProduto } = req.body;
    const { filename, originalname, mimetype } = req.file;
  
    // Faça o processamento necessário com os dados e o arquivo
    // ...
  
    res.sendStatus(200); // Retorna um status de sucesso
  });


// Rota para cadastrar um produto
router.post('/cadastrarProduto', (req, res) => {
    
    try {
        const { nomeProduto, precoProduto, descricaoProduto } = req.body;
      
        const sql = `INSERT INTO produtos (nomeProduto, precoProduto, descricaoProduto) VALUES (?, ?, ?)`;
        const values = [nomeProduto, precoProduto, descricaoProduto];
        connection.query(sql, values, (error, results) => {
            res.status(200).json({ message: 'Produto cadastrado com sucesso' });
        })// ..
      } catch (error) {
        console.error('Erro ao cadastrar o produto:', error);
        // console.error(error.message);
        // res.status(500).json({ message: 'Erro ao cadastrar o produto' });
        // console.log('Erro ao cadastrar o produto:', error);
      }
 
  });

 


module.exports = router;
