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
    -- Guarda o HASH do bcrypt (60 caracteres), nunca a senha. O nome da coluna
    -- continua `senha` para nao quebrar quem ja le a tabela; o conteudo e que
    -- mudou. Hash nao se "desfaz": esquecer a senha significa cadastrar outra.
    senha     TEXT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- NUCLEO DO FLUXO: QR -> pedido -> cozinha -> comanda -> caixa -> fechamento.
--
-- Tudo daqui para baixo nesta secao funciona com TODOS os modulos desligados.
-- ===========================================================================

-- Disponibilidade manual. E o controle de estoque do modo "desligado": o admin
-- liga e desliga o item e ele some do QR. O modulo de estoque, quando ligado,
-- escreve nesta MESMA coluna -- o cardapio so precisa olhar para um lugar.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS disponivel BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS configuracoes (
    chave       TEXT PRIMARY KEY,
    valor       TEXT NOT NULL,
    alterado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mesas (
    id      SERIAL PRIMARY KEY,
    numero  INTEGER UNIQUE NOT NULL,
    apelido TEXT,
    ativa   BOOLEAN NOT NULL DEFAULT true
);

-- O QR da mesa carrega um TOKEN, nao o numero da mesa.
--
-- Com o numero na URL, qualquer pessoa na calcada pede na mesa 7 trocando um
-- digito -- e nao haveria como "cancelar" um QR que vazou. Com token: apagar e
-- gerar outro invalida o adesivo antigo na hora.
ALTER TABLE mesas ADD COLUMN IF NOT EXISTS qr_token TEXT UNIQUE;
ALTER TABLE mesas ADD COLUMN IF NOT EXISTS qr_criado_em TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS comandas (
    id         SERIAL PRIMARY KEY,
    mesa_id    INTEGER NOT NULL REFERENCES mesas (id),
    status     TEXT NOT NULL DEFAULT 'aberta'
               CHECK (status IN ('aberta', 'fechada', 'cancelada')),
    servico    BOOLEAN NOT NULL DEFAULT true,
    desconto   NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0),
    aberta_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
    fechada_em TIMESTAMPTZ
);

-- Uma mesa so pode ter uma conta aberta. Sem isto, dois celulares lendo o QR ao
-- mesmo tempo abrem duas comandas e a mesa paga metade do que consumiu.
CREATE UNIQUE INDEX IF NOT EXISTS comandas_uma_aberta_por_mesa
    ON comandas (mesa_id) WHERE status = 'aberta';

CREATE TABLE IF NOT EXISTS pedidos (
    id          SERIAL PRIMARY KEY,
    comanda_id  INTEGER NOT NULL REFERENCES comandas (id) ON DELETE CASCADE,
    cliente     TEXT,
    -- 'aguardando' = confirmado mas ainda nao liberado para a cozinha (so
    -- acontece no modo de pagamento antecipado). Nos outros modos o pedido
    -- nasce 'novo', ou seja, ja na fila.
    status      TEXT NOT NULL DEFAULT 'novo'
                CHECK (status IN ('aguardando', 'novo', 'preparo', 'pronto', 'entregue', 'cancelado')),
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Momento em que entrou na fila da cozinha. O cronometro da cozinha conta
    -- DAQUI, nao do toque do cozinheiro: e o tempo que o cliente sente.
    liberado_em TIMESTAMPTZ,
    pronto_em   TIMESTAMPTZ,
    entregue_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pedidos_status_idx ON pedidos (status);
CREATE INDEX IF NOT EXISTS pedidos_comanda_idx ON pedidos (comanda_id);

CREATE TABLE IF NOT EXISTS pedido_itens (
    id         SERIAL PRIMARY KEY,
    pedido_id  INTEGER NOT NULL REFERENCES pedidos (id) ON DELETE CASCADE,
    produto_id INTEGER REFERENCES produtos (idnomeProduto) ON DELETE SET NULL,
    -- Nome e preco ficam CONGELADOS no item. Se o produto mudar de preco amanha,
    -- a conta de hoje nao pode mudar junto -- e o produto pode ate ser apagado.
    nome       TEXT NOT NULL,
    preco      NUMERIC(10,2) NOT NULL CHECK (preco >= 0),
    quantidade INTEGER NOT NULL CHECK (quantidade > 0),
    observacao TEXT
);

CREATE INDEX IF NOT EXISTS pedido_itens_pedido_idx ON pedido_itens (pedido_id);

-- Pagamento e do NUCLEO, nao do modulo: o caixa sempre recebe dinheiro, cartao
-- na maquininha e Pix na chave da casa, lancados a mao. O modulo de pagamento
-- integrado so acrescenta formas com origem 'app'.
CREATE TABLE IF NOT EXISTS pagamentos (
    id         SERIAL PRIMARY KEY,
    comanda_id INTEGER NOT NULL REFERENCES comandas (id) ON DELETE CASCADE,
    pedido_id  INTEGER REFERENCES pedidos (id) ON DELETE SET NULL,
    forma      TEXT NOT NULL,
    origem     TEXT NOT NULL DEFAULT 'caixa' CHECK (origem IN ('caixa', 'app')),
    valor      NUMERIC(10,2) NOT NULL CHECK (valor > 0),
    -- Taxa da adquirente. Fica aqui e nao no financeiro porque e um fato do
    -- pagamento; o financeiro so soma.
    taxa       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (taxa >= 0),
    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pagamentos_comanda_idx ON pagamentos (comanda_id);

-- ===========================================================================
-- MODULO ESTOQUE (opcional). Nada no nucleo le estas tabelas.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ingredientes (
    id         SERIAL PRIMARY KEY,
    nome       TEXT UNIQUE NOT NULL,
    unidade    TEXT NOT NULL DEFAULT 'un',
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    minimo     NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (minimo >= 0)
);

-- Quanto de cada ingrediente sai do estoque por UMA unidade do produto.
CREATE TABLE IF NOT EXISTS ficha_tecnica (
    produto_id     INTEGER NOT NULL REFERENCES produtos (idnomeProduto) ON DELETE CASCADE,
    ingrediente_id INTEGER NOT NULL REFERENCES ingredientes (id) ON DELETE CASCADE,
    quantidade     NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
    PRIMARY KEY (produto_id, ingrediente_id)
);

CREATE TABLE IF NOT EXISTS estoque_mov (
    id             SERIAL PRIMARY KEY,
    ingrediente_id INTEGER REFERENCES ingredientes (id) ON DELETE CASCADE,
    produto_id     INTEGER REFERENCES produtos (idnomeProduto) ON DELETE SET NULL,
    tipo           TEXT NOT NULL CHECK (tipo IN ('entrada', 'baixa', 'perda', 'ajuste')),
    quantidade     NUMERIC(12,3) NOT NULL,
    pedido_id      INTEGER REFERENCES pedidos (id) ON DELETE SET NULL,
    nota           TEXT,
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estoque_mov_criado_idx ON estoque_mov (criado_em DESC);
