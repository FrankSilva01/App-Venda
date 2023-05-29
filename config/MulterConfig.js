const multer = require('multer');
const path = require('path');

// Configuração do Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const filename = file.fieldname + '-' + Date.now() + ext;
      cb(null, filename);
    },
  });
  
  const upload = multer({ storage });


module.exports = upload;

