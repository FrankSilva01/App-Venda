const fs = require('fs');
const multer = require('multer');
const path = require('path');

// Caminho ABSOLUTO, e o mesmo que o Server.js publica em /upload.
//
// Era 'uploads/', relativo ao diretorio de onde o processo foi iniciado. O
// servidor, por outro lado, publica __dirname/uploads. Rodando de qualquer pasta
// que nao fosse a do servidor, o arquivo era gravado num lugar e servido de
// outro -- e quando a pasta nao existia o upload estourava com ENOENT, que foi o
// que aconteceu no primeiro teste contra o Postgres.
const PASTA = path.join(__dirname, 'server', 'uploads');
fs.mkdirSync(PASTA, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PASTA),
  filename: (req, file, cb) => {
    // Nome proprio e nao o original: dois clientes enviando "foto.png"
    // sobrescreviam um ao outro, e o nome original ainda carrega o que o
    // navegador mandar (incluindo barra e ..).
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, file.fieldname + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  },
});

const upload = multer({
  storage,
  // Teto por arquivo: sem isso qualquer um enche o disco do servidor.
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error('Envie uma imagem.'));
  },
});

module.exports = upload;
module.exports.PASTA_UPLOADS = PASTA;
