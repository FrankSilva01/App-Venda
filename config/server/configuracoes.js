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

  'geral.nome': 'App-Venda',

  // Taxa de servico: ligar/desligar para a casa, o percentual, e se o caixa
  // pode tirar na comanda. Antes era so o percentual, e "nao cobrar" nao
  // existia como configuracao -- so dava para zerar o numero, que e outra
  // coisa (10% de nada continua aparecendo como linha na conta).
  'servico.ativo': 'true',
  'servico.percentual': '10',
  'servico.editavel_no_caixa': 'true',

  // Operacao
  'operacao.cliente_fecha': 'true',
  'operacao.garcom_lanca': 'true',

  // Cozinha: a partir de quantos minutos o card muda de cor.
  'cozinha.atencao_min': '10',
  'cozinha.atraso_min': '20',

  // Endereco tecnico (URL do cliente, IP da API) na tela. Serve para instalar e
  // depurar; em operacao normal e ruido e vaza o desenho da rede.
  'dev.mostrar_enderecos': 'false',
  // Endereco da tela do cliente -- e o que vai dentro do QR da mesa. Em
  // producao e a URL publica; em teste, o http://localhost:... da sua maquina.
  'cliente.url': 'https://franksilva01.github.io/App-Venda/mesa.html',

  // Enderecos conhecidos, um por linha, no formato `rotulo|url`.
  //
  // A mesma maquina muda de IP conforme a rede (casa, trabalho). Um QR carrega
  // UM endereco, entao nao da para servir duas redes com o mesmo adesivo -- mas
  // da para guardar os dois e trocar o ativo num clique, sem redigitar IP e sem
  // gerar token novo: o desenho do QR sai da configuracao do momento.
  'cliente.enderecos': '',

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
  'servico.ativo': ['true', 'false'],
  'servico.editavel_no_caixa': ['true', 'false'],
  'operacao.cliente_fecha': ['true', 'false'],
  'operacao.garcom_lanca': ['true', 'false'],
  'dev.mostrar_enderecos': ['true', 'false'],
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

  if (!String(novo['geral.nome']).trim()) {
    throw recusa('O nome do estabelecimento não pode ficar vazio.');
  }

  const atencao = Number(novo['cozinha.atencao_min']);
  const atraso = Number(novo['cozinha.atraso_min']);
  if (!Number.isFinite(atencao) || !Number.isFinite(atraso) || atencao < 1 || atraso < 1) {
    throw recusa('Os tempos da cozinha precisam ser números de minutos.');
  }
  // Atraso antes da atencao pintaria o card de vermelho e depois de amarelo --
  // a cor andaria para tras conforme o pedido demora.
  if (atraso <= atencao) {
    throw recusa('O tempo de atraso precisa ser maior que o de atenção.');
  }

  // URL torta vira QR que nao abre nada -- e so se descobre com o adesivo ja
  // colado na mesa.
  if (!/^https?:\/\/.+/.test(novo['cliente.url'])) {
    throw recusa('A URL da tela do cliente precisa começar com http:// ou https://.');
  }

  // Cada linha da lista precisa ser `rotulo|url` com url de verdade. Guardar um
  // endereço quebrado aqui só se descobre no celular do cliente, com o adesivo
  // já colado na mesa.
  String(novo['cliente.enderecos'] || '').split('\n').forEach((linha) => {
    const l = linha.trim();
    if (!l) return;
    const url = l.indexOf('|') >= 0 ? l.slice(l.indexOf('|') + 1).trim() : l;
    if (!/^https?:\/\/.+/.test(url)) throw recusa('Endereço inválido na lista: ' + l);
  });
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
