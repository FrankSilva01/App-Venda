// Base compartilhada por login.html, index.html e mesa.html.
//
// Antes cada pagina tinha a sua copia de $(), esc(), moeda() e do fetch -- e as
// copias ja tinham comecado a divergir no tratamento de erro.

// A pagina e estatica (GitHub Pages) e conversa com a API que roda na maquina
// do restaurante. O navegador bloqueia HTTP dentro de HTTPS, menos para
// localhost, que o Chrome trata como origem confiavel; e o que faz este
// arranjo funcionar sem certificado.
var API = localStorage.getItem('appvenda-api') || 'http://localhost:3001';

function guardaApi(url) {
  API = String(url || '').replace(/\/+$/, '');
  localStorage.setItem('appvenda-api', API);
}

// Sessao: token + usuario. Fica no localStorage porque as paginas sao estaticas
// e nao ha servidor nosso para por cookie de sessao.
function sessao() {
  try { return JSON.parse(localStorage.getItem('appvenda-sessao') || 'null'); }
  catch (e) { return null; }
}
function guardaSessao(s) { localStorage.setItem('appvenda-sessao', JSON.stringify(s)); }
function esqueceSessao() { localStorage.removeItem('appvenda-sessao'); }

// A tela do cliente liga isto. Ela e servida do MESMO host do painel, entao
// divide o localStorage com ele: sem esta trava, o celular de um funcionario
// logado mandaria o token do painel junto com o pedido da mesa, e o pedido
// seria gravado como "do garcom" em vez de "do QR". A credencial do cliente e
// o token do QR, e so.
var SEM_SESSAO = false;

function cabecalhos(extra) {
  var h = extra || {};
  if (SEM_SESSAO) return h;
  var s = sessao();
  // Token em cabecalho, nunca na URL: querystring fica no historico do
  // navegador, no Referer e no log de qualquer proxy no caminho.
  if (s && s.token) h.Authorization = 'Bearer ' + s.token;
  return h;
}

var $ = function (s, raiz) { return (raiz || document).querySelector(s); };
var $$ = function (s, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(s)); };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function moeda(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ','); }

function minutos(segundos) {
  var m = Math.floor((segundos || 0) / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
}

function aviso(onde, tipo, texto) {
  var el = typeof onde === 'string' ? $(onde) : onde;
  if (el) el.innerHTML = '<div class="aviso ' + tipo + '">' + esc(texto) + '</div>';
}

// Chamada a API. Erro vira Error com a mensagem do servidor -- quem chama so
// precisa de try/catch.
async function api(caminho, opcoes) {
  var o = opcoes || {};
  o.headers = cabecalhos(o.headers || {});
  var r = await fetch(API + caminho, o);
  var txt = await r.text();
  var dados = null;
  try { dados = txt ? JSON.parse(txt) : null; } catch (e) { dados = { message: txt }; }
  if (!r.ok) {
    var e = new Error((dados && (dados.message || dados.error)) || ('HTTP ' + r.status));
    e.status = r.status;
    e.dados = dados;
    throw e;
  }
  return dados;
}

// Tempo real. EventSource nao aceita cabecalho, e o token de sessao nao pode ir
// na URL -- entao lemos o fluxo SSE com fetch, que aceita. O formato na linha e
// o mesmo ("data: {...}"), so o transporte muda.
function ouveFluxo(caminho, aoReceber) {
  var parar = false;
  var controle = null;

  async function liga() {
    while (!parar) {
      try {
        controle = new AbortController();
        var r = await fetch(API + caminho, { headers: cabecalhos(), signal: controle.signal });
        if (!r.ok || !r.body) throw new Error('sem fluxo');
        var leitor = r.body.getReader();
        var dec = new TextDecoder();
        var resto = '';
        while (!parar) {
          var p = await leitor.read();
          if (p.done) break;
          resto += dec.decode(p.value, { stream: true });
          var partes = resto.split('\n\n');
          resto = partes.pop();
          partes.forEach(function (bloco) {
            var linha = bloco.split('\n').find(function (l) { return l.indexOf('data: ') === 0; });
            if (!linha) return;                       // batida de keep-alive
            try { aoReceber(JSON.parse(linha.slice(6))); } catch (e) { /* ignora */ }
          });
        }
      } catch (e) {
        if (parar) return;
      }
      // Caiu (rede, API reiniciada): espera e tenta de novo. Sem isto, a tela
      // da cozinha congela sem avisar quando alguem reinicia a API.
      await new Promise(function (r) { setTimeout(r, 3000); });
    }
  }

  liga();
  return function () { parar = true; if (controle) controle.abort(); };
}

// Avisos de canto. O garcom nao fica olhando para a tela: o chamado de mesa
// precisa aparecer por cima do que ele estiver fazendo.
function toast(texto, acao) {
  var caixa = $('.toasts');
  if (!caixa) {
    caixa = document.createElement('div');
    caixa.className = 'toasts';
    document.body.appendChild(caixa);
  }
  var t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = '<span style="flex:1">' + esc(texto) + '</span>';
  if (acao) {
    var b = document.createElement('button');
    b.className = 'btn pequeno';
    b.textContent = acao.rotulo;
    b.onclick = function () { t.remove(); acao.ao(); };
    t.appendChild(b);
  }
  caixa.appendChild(t);
  setTimeout(function () { t.remove(); }, acao ? 15000 : 6000);
}
