const express = require('express');
const router = express.Router();
const connection = require('../server/Server.js');

router.get('/produtos', (req, res) => {
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