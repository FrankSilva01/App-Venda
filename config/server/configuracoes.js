// Configuracao por estabelecimento: quais modulos estao ligados e como.
//
// Mora no banco (tabela configuracoes) para mudar sem reiniciar o servidor, e
// fica em cache na memoria para nao dar um SELECT a cada pedido. O cache cai
// quando alguem salva.
const { query } = require('./dbConnection');

// O padrao e o produto SEM modulo nenhum: pedido vai direto para a cozinha e a
// conta e paga no caixa, no fim. E o fluxo que funciona sozinho.
const PADRAO = {
  'pagamento.modo': 'fechamento',
  'pagamento.integrado': 'false',
  'estoque.modo': 'desligado',
  'financeiro.ativo': 'true',
  'servico.percentual': '10',
  // Endereco da tela do cliente -- e o que vai dentro do QR da mesa. Em
  // producao e a URL publica; em teste, o http://localhost:... da sua maquina.
  'cliente.url': 'https://franksilva01.github.io/App-Venda/mesa.html',
  // Endereco da API visto pelo CELULAR do cliente. Em branco, a tela do cliente
  // usa o que estiver guardado no navegador. Nao da para adivinhar: a API roda
  // na maquina do restaurante e "localhost" no celular e o proprio celular.
  'api.publica': '',
};

const VALORES = {
  'pagamento.modo': ['fechamento', 'antecipado', 'ambos'],
  'pagamento.integrado': ['true', 'false'],
  'estoque.modo': ['desligado', 'simples', 'ingrediente'],
  'financeiro.ativo': ['true', 'false'],
};

let cache = null;

// Erro de VALIDACAO, marcado. O Server devolve 400 para estes e 500 para o
// resto. A versao anterior adivinhava pela mensagem, com uma regex sobre o
// texto -- bastou acrescentar uma frase nova para um 400 virar 500.
function recusa(mensagem) {
  const e = new Error(mensagem);
  e.validacao = true;
  return e;
}

async function todas() {
  if (cache) return cache;
  const r = await query('SELECT chave, valor FROM configuracoes');
  const lidas = {};
  r.rows.forEach((l) => { lidas[l.chave] = l.valor; });
  // Padrao por baixo: chave que ninguem salvou ainda tem valor mesmo assim, e
  // uma configuracao nova nao quebra instalacao antiga.
  cache = Object.assign({}, PADRAO, lidas);
  return cache;
}

async function ler(chave) {
  return (await todas())[chave];
}

async function ligado(chave) {
  return (await ler(chave)) === 'true';
}

// Nome do modulo -> esta ligado? Usado pelo Server para barrar a rota e pelos
// proprios modulos antes de reagir a um evento.
async function moduloAtivo(nome) {
  if (nome === 'pagamento') return ligado('pagamento.integrado');
  if (nome === 'estoque') return (await ler('estoque.modo')) !== 'desligado';
  if (nome === 'financeiro') return ligado('financeiro.ativo');
  return false;
}

async function salvar(mudancas) {
  const atual = await todas();
  const novo = Object.assign({}, atual);

  Object.keys(mudancas).forEach((chave) => {
    if (!(chave in PADRAO)) throw recusa('Configuração desconhecida: ' + chave);
    const valor = String(mudancas[chave]);
    if (VALORES[chave] && VALORES[chave].indexOf(valor) < 0) {
      throw recusa('Valor inválido para ' + chave + ': ' + valor);
    }
    novo[chave] = valor;
  });

  const pct = Number(novo['servico.percentual']);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw recusa('Percentual de serviço deve ficar entre 0 e 100.');
  }

  // URL torta vira QR que nao abre nada -- e so se descobre com o adesivo ja
  // colado na mesa.
  if (!/^https?:\/\/.+/.test(novo['cliente.url'])) {
    throw recusa('A URL da tela do cliente precisa começar com http:// ou https://.');
  }
  if (novo['api.publica'] && !/^https?:\/\/.+/.test(novo['api.publica'])) {
    throw recusa('O endereço público da API precisa começar com http:// ou https://.');
  }

  // Combinacao que nao fecha: "so entra na cozinha depois de pago" com a cobranca
  // desligada significa pedido que nunca chega na cozinha. Barra aqui, com o
  // motivo, em vez de deixar a casa descobrir no movimento.
  if (novo['pagamento.modo'] === 'antecipado' && novo['pagamento.integrado'] !== 'true') {
    throw recusa('Pagamento antecipado exige o módulo de pagamento integrado ligado.');
  }

  for (const chave of Object.keys(mudancas)) {
    await query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, alterado_em = now()`,
      [chave, String(mudancas[chave])]
    );
  }

  cache = null;
  return todas();
}

function esquece() {
  cache = null;
}

module.exports = { todas, ler, ligado, moduloAtivo, salvar, esquece, PADRAO, VALORES };
