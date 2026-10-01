-- Esquema do App-Venda no PostgreSQL.
--
-- Deduzido das consultas que o Server.js ja fazia: nao havia script de banco no
-- repositorio, entao as tabelas so existiam na maquina de quem escreveu.

CREATE TABLE IF NOT EXISTS produtos (
    -- O nome vem do codigo: a rota de deletar usa WHERE idnomeProduto = $1.
    idnomeProduto     SERIAL PRIMARY KEY,
    nomeProduto       TEXT           NOT NULL,
    -- NUMERIC e nao float: dinheiro em ponto flutuante acumula centavo errado.
    precoProduto      NUMERIC(10,2)  NOT NULL CHECK (precoProduto >= 0),
    descricaoProduto  TEXT,
    imagemProduto     TEXT,
    quantidadeProduto INTEGER        NOT NULL DEFAULT 0 CHECK (quantidadeProduto >= 0),
    categoria         TEXT,
    criado_em         TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- A tela filtra produto por categoria (bebidas, comidas...), e e a consulta mais
-- repetida do app.
CREATE INDEX IF NOT EXISTS produtos_categoria_idx ON produtos (categoria);

CREATE TABLE IF NOT EXISTS usuarios (
    id        SERIAL PRIMARY KEY,
    login     TEXT UNIQUE NOT NULL,
    email     TEXT UNIQUE NOT NULL,
    cpf       TEXT UNIQUE NOT NULL,
    -- ATENCAO: hoje o app grava a senha em texto puro. As restricoes UNIQUE acima
    -- resolvem um item do Etapas.txt ("informar que o usuario ja existe"), mas a
    -- senha continua como estava. Trocar por hash (bcrypt) muda o cadastro e o
    -- login juntos -- ver o README.
    senha     TEXT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
