// Painel do restaurante.
//
// Uma pagina, telas por hash (#/salao, #/cozinha...). Sem build, sem framework:
// e a mesma escolha do resto do projeto, e o que permite publicar no GitHub
// Pages sem etapa de compilacao.
//
// O menu e desenhado a partir das AREAS que o servidor devolve no login. Nao e
// seguranca -- a seguranca esta na API, que recusa 403 -- e sim nao mostrar ao
// garcom quatro botoes que vao dar erro na cara dele.

var SESSAO = sessao();
var CFG = {};
var AREAS = [];
var CHAMADOS = [];
var pararFluxo = null;
var pararRelogio = null;

var TELAS = [
  { id: 'salao',      area: 'salao',      titulo: 'Salão' },
  { id: 'cozinha',    area: 'cozinha',    titulo: 'Cozinha' },
  { id: 'caixa',      area: 'caixa',      titulo: 'Caixa' },
  { id: 'cardapio',   area: 'cardapio',   titulo: 'Cardápio' },
  { id: 'mesas',      area: 'mesas',      titulo: 'Mesas & QR' },
  { id: 'relatorios', area: 'relatorios', titulo: 'Relatórios' },
  { id: 'usuarios',   area: 'usuarios',   titulo: 'Usuários' },
  { id: 'config',     area: 'config',     titulo: 'Configurações' },
];

function telaAtual() {
  var id = (location.hash || '').replace('#/', '') || (AREAS.length ? primeiraTela() : 'salao');
  return TELAS.filter(function (t) { return t.id === id; })[0] || TELAS[0];
}

// A primeira tela depende do perfil: a cozinha nao deve cair no salao e ver
// 403 antes de entender onde esta.
function primeiraTela() {
  var t = TELAS.filter(function (x) { return AREAS.indexOf(x.area) >= 0; })[0];
  return t ? t.id : 'salao';
}

function pintaMenu() {
  var atual = telaAtual().id;
  $('#menu').innerHTML = TELAS
    .filter(function (t) { return AREAS.indexOf(t.area) >= 0; })
    .map(function (t) {
      var n = t.id === 'salao' && CHAMADOS.length
        ? '<span class="sino">' + CHAMADOS.length + '</span>' : '';
      return '<a href="#/' + t.id + '"' + (t.id === atual ? ' class="on"' : '') + '>' +
        esc(t.titulo) + n + '</a>';
    }).join('');
}

// --------------------------------------------------------------- salão
async function telaSalao() {
  var filtro = telaSalao.filtro || 'todas';
  var busca = (telaSalao.busca || '').toLowerCase();
  var mesas = [];
  try { mesas = await api('/api/salao'); } catch (e) { return aviso('#tela', 'erro', e.message); }

  var rotulos = {
    livre: ['Livre', ''], ocupada: ['Ocupada', 'verde'],
    preparo: ['Em preparo', 'azul'], pronto: ['Pedido pronto', 'verde'],
    aguardando_pagamento: ['Aguardando pagamento', 'laranja'],
    atendimento: ['Solicitou atendimento', 'vermelho'],
    fechamento: ['Solicitou fechamento', 'laranja'],
  };
  var grupos = {
    todas: function () { return true; },
    livres: function (m) { return m.situacao === 'livre'; },
    ocupadas: function (m) { return m.situacao !== 'livre'; },
    atendimento: function (m) { return m.situacao === 'atendimento'; },
    fechamento: function (m) { return m.situacao === 'fechamento'; },
  };

  var lista = mesas.filter(grupos[filtro]).filter(function (m) {
    return !busca || String(m.numero).indexOf(busca) === 0 ||
      (m.area || '').toLowerCase().indexOf(busca) >= 0;
  });

  $('#tela').innerHTML =
    '<div class="entre" style="margin-bottom:14px;flex-wrap:wrap">' +
      '<input id="busca" placeholder="Buscar mesa ou área…" style="max-width:260px" value="' +
        esc(telaSalao.busca || '') + '">' +
      '<div class="filtros" style="margin:0">' +
        Object.keys(grupos).map(function (g) {
          var n = mesas.filter(grupos[g]).length;
          return '<button data-f="' + g + '"' + (g === filtro ? ' class="on"' : '') + '>' +
            g.charAt(0).toUpperCase() + g.slice(1) + ' ' + n + '</button>';
        }).join('') +
      '</div>' +
    '</div>' +
    (lista.length
      ? '<div class="grade auto">' + lista.map(function (m) {
          var r = rotulos[m.situacao] || rotulos.livre;
          var cor = { verde: 'var(--verde)', azul: 'var(--azul)', laranja: 'var(--laranja)',
                      vermelho: 'var(--vermelho)' }[r[1]] || 'var(--linha)';
          return '<button class="cartao" data-mesa="' + m.id + '" style="text-align:left;' +
            'cursor:pointer;margin:0;border-left:4px solid ' + cor + ';font:inherit;color:inherit">' +
            '<div class="entre"><b style="font-size:18px">Mesa ' + m.numero + '</b>' +
              '<span class="chip empurra">' + esc(m.area || '') + '</span></div>' +
            '<div class="chip ' + r[1] + '" style="margin-top:8px">' + r[0] + '</div>' +
            (m.comanda_id
              ? '<div style="margin-top:10px;font-size:19px;font-weight:700">' +
                  moeda(m.totais.total) + '</div>' +
                '<div class="nota">' + m.pedidos + ' pedido' + (m.pedidos === 1 ? '' : 's') +
                  ' · ' + minutos(m.segundos_aberta) + '</div>'
              : '<div class="nota" style="margin-top:10px">Sem conta aberta</div>') +
          '</button>';
        }).join('') + '</div>'
      : '<div class="vazio">Nenhuma mesa aqui.</div>');

  $('#busca').oninput = function () {
    telaSalao.busca = this.value;
    // Repinta so a lista: refazer a tela a cada tecla tiraria o foco do campo.
    clearTimeout(telaSalao.t);
    telaSalao.t = setTimeout(telaSalao, 180);
  };
  $$('[data-f]').forEach(function (b) {
    b.onclick = function () { telaSalao.filtro = b.getAttribute('data-f'); telaSalao(); };
  });
  $$('[data-mesa]').forEach(function (b) {
    b.onclick = function () { abreMesa(Number(b.getAttribute('data-mesa'))); };
  });
}

// Gaveta da mesa: a comanda, o historico e o lançamento de pedido pelo garçom.
async function abreMesa(mesaId) {
  var mesas = await api('/api/salao');
  var m = mesas.filter(function (x) { return x.id === mesaId; })[0];
  if (!m) return;

  var d = m.comanda_id ? await api('/api/comandas/' + m.comanda_id) : null;
  var g = document.createElement('div');
  g.className = 'gaveta';
  g.innerHTML = '<div><header><h2>Mesa ' + m.numero + '</h2>' +
    '<span class="chip empurra">' + esc(m.area || '') + '</span>' +
    '<button class="btn sec pequeno" id="fechaGaveta">Fechar</button></header>' +
    '<div id="conteudoGaveta"></div></div>';
  document.body.appendChild(g);
  g.onclick = function (ev) { if (ev.target === g) g.remove(); };
  $('#fechaGaveta', g).onclick = function () { g.remove(); };

  var c = $('#conteudoGaveta', g);
  c.innerHTML =
    (m.chamados.length
      ? '<div class="cartao" style="border-color:var(--laranja)"><div class="entre">' +
          '<b>' + (m.chamados[0].tipo === 'fechamento' ? 'Solicitou fechamento' : 'Chamou o garçom') +
          '</b><button class="btn pequeno empurra" id="resolveChamado">Resolver</button></div></div>'
      : '') +
    (d
      ? '<div class="cartao"><div class="entre" style="margin-bottom:10px">' +
          '<span class="nota">Comanda aberta há ' + minutos(m.segundos_aberta) + '</span>' +
          '<b class="empurra" style="font-size:19px">' + moeda(d.totais.total) + '</b></div>' +
          d.pedidos.map(function (p) {
            return '<div style="border-top:1px solid var(--linha-fraca);padding-top:10px;margin-top:10px">' +
              '<div class="entre"><b>#' + p.id + '</b>' +
                '<span class="chip ' + (p.origem === 'qr' ? 'azul' : '') + '">' +
                  (p.origem === 'qr' ? 'Cliente/QR' : 'Garçom') + '</span>' +
                '<span class="chip ' + (p.status === 'cancelado' ? 'vermelho' : '') + '">' +
                  p.status + '</span>' +
                (['novo', 'preparo', 'pronto', 'aguardando'].indexOf(p.status) >= 0
                  ? '<button class="btn sec pequeno empurra" data-cancela="' + p.id + '">Cancelar</button>'
                  : '') +
              '</div>' +
              p.itens.map(function (i) {
                return '<div class="item" style="border:0;padding:4px 0">' +
                  '<b>' + i.quantidade + '×</b> ' + esc(i.nome) +
                  (i.observacao ? '<span class="chip laranja">' + esc(i.observacao) + '</span>' : '') +
                  '<span class="empurra">' + moeda(i.preco * i.quantidade) + '</span></div>';
              }).join('') +
            '</div>';
          }).join('') +
        '</div>'
      : '<div class="cartao"><div class="vazio">Mesa livre. O primeiro pedido abre a conta.</div></div>') +
    (CFG['operacao.garcom_lanca'] === 'true'
      ? '<button class="btn largo" id="addPedido">+ Adicionar pedido</button>'
      : '<p class="nota">Lançamento pelo garçom está desligado em Configurações.</p>') +
    (d ? '<div class="cartao" style="margin-top:16px"><h2>Histórico</h2><div id="hist" class="nota">…</div></div>' : '');

  if ($('#resolveChamado', c)) {
    $('#resolveChamado', c).onclick = async function () {
      await api('/api/chamados/' + m.chamados[0].id + '/resolver', { method: 'POST' });
      g.remove(); telaSalao(); carregaChamados();
    };
  }
  $$('[data-cancela]', c).forEach(function (b) {
    b.onclick = async function () {
      var motivo = prompt('Motivo do cancelamento:');
      if (!motivo) return;
      try {
        await api('/api/pedidos/' + b.getAttribute('data-cancela') + '/cancelar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo: motivo }),
        });
        g.remove(); abreMesa(mesaId); telaSalao();
      } catch (e) { alert(e.message); }
    };
  });
  if ($('#addPedido', c)) {
    $('#addPedido', c).onclick = function () { g.remove(); pedidoDoGarcom(m); };
  }
  if (d) {
    api('/api/comandas/' + m.comanda_id + '/historico').then(function (h) {
      if (!$('#hist', c)) return;
      $('#hist', c).innerHTML = h.map(function (l) {
        return '<div>' + new Date(l.criado_em).toLocaleTimeString('pt-BR').slice(0, 5) + ' · ' +
          esc(l.evento) + (l.usuario ? ' · ' + esc(l.usuario) : '') +
          (l.detalhe && l.detalhe.motivo ? ' · ' + esc(l.detalhe.motivo) : '') + '</div>';
      }).join('');
    }).catch(function () {});
  }
}

// Lançamento manual: mesmo cardápio do cliente, mesma rota de pedido -- o que
// muda é que vai com sessão, e o servidor carimba origem=garcom.
async function pedidoDoGarcom(m) {
  var dados = await api('/api/mesa/' + m.numero + '/cardapio');
  var carrinho = [];

  var g = document.createElement('div');
  g.className = 'gaveta';
  g.innerHTML = '<div><header><h2>Pedido · mesa ' + m.numero + '</h2>' +
    '<button class="btn sec pequeno empurra" id="x">Cancelar</button></header>' +
    '<div id="cardapio"></div>' +
    '<div class="cartao" id="resumo"></div></div>';
  document.body.appendChild(g);
  $('#x', g).onclick = function () { g.remove(); };

  $('#cardapio', g).innerHTML = '<div class="cartao">' + dados.produtos.map(function (p) {
    return '<div class="item"><b>' + esc(p.nomeproduto) + '</b>' +
      '<span class="nota">' + moeda(p.precoproduto) + '</span>' +
      '<button class="btn sec pequeno empurra" data-add="' + p.idnomeproduto + '">Adicionar</button></div>';
  }).join('') + '</div>';

  function resumo() {
    var total = carrinho.reduce(function (s, i) { return s + i.preco * i.qtd; }, 0);
    $('#resumo', g).innerHTML = '<h2>Pedido</h2>' +
      (carrinho.length ? carrinho.map(function (i, n) {
        return '<div class="item"><b>' + i.qtd + '×</b> ' + esc(i.nome) +
          '<span class="empurra">' + moeda(i.preco * i.qtd) + '</span>' +
          '<button class="btn sec pequeno" data-rm="' + n + '">×</button></div>' +
          '<input data-obs="' + n + '" placeholder="observação" value="' + esc(i.obs || '') +
            '" style="margin-bottom:8px">';
      }).join('') + '<div class="total"><span>Total</span><b>' + moeda(total) + '</b></div>' +
        '<button class="btn largo" id="confirma" style="margin-top:12px">Confirmar e enviar à cozinha</button>'
        : '<div class="vazio">Escolha os itens acima.</div>');

    $$('[data-rm]', g).forEach(function (b) {
      b.onclick = function () { carrinho.splice(Number(b.getAttribute('data-rm')), 1); resumo(); };
    });
    $$('[data-obs]', g).forEach(function (c) {
      c.oninput = function () { carrinho[Number(c.getAttribute('data-obs'))].obs = c.value; };
    });
    if ($('#confirma', g)) {
      $('#confirma', g).onclick = async function () {
        this.disabled = true;
        try {
          await api('/api/pedidos', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mesa: m.numero,
              itens: carrinho.map(function (i) {
                return { produto_id: i.id, quantidade: i.qtd, observacao: i.obs || null };
              }),
            }),
          });
          g.remove();
          toast('Pedido enviado para a cozinha.');
          telaSalao();
        } catch (e) { alert(e.message); this.disabled = false; }
      };
    }
  }

  $$('[data-add]', g).forEach(function (b) {
    b.onclick = function () {
      var p = dados.produtos.filter(function (x) {
        return x.idnomeproduto === Number(b.getAttribute('data-add'));
      })[0];
      var ja = carrinho.filter(function (x) { return x.id === p.idnomeproduto && !x.obs; })[0];
      if (ja) ja.qtd++;
      else carrinho.push({ id: p.idnomeproduto, nome: p.nomeproduto, preco: Number(p.precoproduto), qtd: 1 });
      resumo();
    };
  });
  resumo();
}

// -------------------------------------------------------------- cozinha
async function telaCozinha() {
  var fila = [];
  try { fila = await api('/api/cozinha'); } catch (e) { return aviso('#tela', 'erro', e.message); }

  var atencao = Number(CFG['cozinha.atencao_min'] || 10) * 60;
  var atraso = Number(CFG['cozinha.atraso_min'] || 20) * 60;
  var colunas = [
    { nome: 'Novos', status: 'novo', acao: 'preparo', rotulo: 'Iniciar preparo' },
    { nome: 'Em preparo', status: 'preparo', acao: 'pronto', rotulo: 'Marcar pronto' },
    { nome: 'Prontos', status: 'pronto', acao: 'entregue', rotulo: 'Marcar entregue' },
  ];

  $('#tela').innerHTML = '<div class="grade g3" style="align-items:start">' +
    colunas.map(function (col) {
      var cards = fila.filter(function (p) { return p.status === col.status; });
      return '<div><div class="entre" style="margin-bottom:10px">' +
          '<h2>' + col.nome + '</h2><span class="chip">' + cards.length + '</span></div>' +
        (cards.length ? cards.map(function (p) {
          // A cor do card e so o tempo. A cozinha le de longe e nao vai parar
          // para interpretar legenda.
          var cor = p.segundos_na_fila > atraso ? 'var(--vermelho)'
            : (p.segundos_na_fila > atencao ? 'var(--laranja)' : 'var(--linha)');
          return '<div class="cartao" style="border-left:4px solid ' + cor + '">' +
            '<div class="entre">' +
              '<b style="font-size:20px">Mesa ' + p.mesa + '</b>' +
              '<span class="nota">#' + p.id + '</span>' +
              '<span class="chip ' + (p.origem === 'qr' ? 'azul' : '') + '">' +
                (p.origem === 'qr' ? 'QR' : 'Garçom') + '</span>' +
              '<b class="empurra cronometro" data-desde="' + p.liberado_em + '" ' +
                'style="font-size:19px;font-variant-numeric:tabular-nums">' +
                minutos(p.segundos_na_fila) + '</b>' +
            '</div>' +
            '<div style="margin:10px 0">' + p.itens.map(function (i) {
              return '<div style="font-size:17px;margin-bottom:6px">' +
                '<b>' + i.quantidade + '×</b> ' + esc(i.nome) +
                (i.adicionais && i.adicionais.length
                  ? '<div class="nota">+ ' + i.adicionais.map(function (a) {
                      return esc(a.nome); }).join(', ') + '</div>' : '') +
                (i.observacao
                  ? '<div class="chip laranja" style="margin-top:4px">' + esc(i.observacao) + '</div>'
                  : '') + '</div>';
            }).join('') + '</div>' +
            '<button class="btn largo" data-etapa="' + p.id + ':' + col.acao + '">' +
              col.rotulo + '</button>' +
          '</div>';
        }).join('') : '<div class="cartao"><div class="vazio">—</div></div>') +
      '</div>';
    }).join('') + '</div>';

  $$('[data-etapa]').forEach(function (b) {
    b.onclick = async function () {
      var p = b.getAttribute('data-etapa').split(':');
      b.disabled = true;
      try { await api('/api/pedidos/' + p[0] + '/' + p[1], { method: 'POST' }); }
      catch (e) { alert(e.message); b.disabled = false; }
      telaCozinha();
    };
  });

  // O cronometro anda sozinho, sem refazer a tela: a lista so muda quando chega
  // evento, mas o tempo passa de qualquer jeito.
  if (pararRelogio) clearInterval(pararRelogio);
  pararRelogio = setInterval(function () {
    $$('.cronometro').forEach(function (el) {
      var s = Math.floor((Date.now() - new Date(el.getAttribute('data-desde'))) / 1000);
      el.textContent = minutos(s);
      var card = el.closest('.cartao');
      if (card) {
        card.style.borderLeftColor = s > atraso ? 'var(--vermelho)'
          : (s > atencao ? 'var(--laranja)' : 'var(--linha)');
      }
    });
  }, 10000);
}

// ---------------------------------------------------------------- caixa
async function telaCaixa() {
  var comandas = [];
  try { comandas = await api('/api/comandas?status=aberta'); }
  catch (e) { return aviso('#tela', 'erro', e.message); }

  $('#tela').innerHTML =
    '<div class="grade" style="grid-template-columns:minmax(0,280px) minmax(0,1fr);align-items:start">' +
      '<div class="cartao"><h2>Comandas abertas</h2><div id="lista"></div></div>' +
      '<div id="detalhe"></div>' +
    '</div>';

  $('#lista').innerHTML = comandas.length ? comandas.map(function (c) {
    return '<button class="item" data-c="' + c.id + '" style="width:100%;background:0;border:0;' +
      'border-bottom:1px solid var(--linha-fraca);font:inherit;color:inherit;cursor:pointer;text-align:left">' +
      '<b>Mesa ' + c.mesa + '</b>' +
      '<span class="empurra" style="font-weight:700">' + moeda(c.totais.total) + '</span></button>';
  }).join('') : '<div class="vazio">Nenhuma conta aberta.</div>';

  $$('[data-c]').forEach(function (b) {
    b.onclick = function () { detalheCaixa(Number(b.getAttribute('data-c'))); };
  });
  if (comandas.length) detalheCaixa(telaCaixa.atual || comandas[0].id);
}

async function detalheCaixa(id) {
  telaCaixa.atual = id;
  var d;
  try { d = await api('/api/comandas/' + id); }
  catch (e) { return aviso('#detalhe', 'erro', e.message); }

  var itens = [];
  d.pedidos.forEach(function (p) {
    if (p.status === 'cancelado') return;
    p.itens.forEach(function (i) { itens.push(Object.assign({ pedido: p.id }, i)); });
  });
  var editavel = CFG['servico.editavel_no_caixa'] === 'true';

  $('#detalhe').innerHTML =
    '<div class="cartao"><div class="entre"><h2>Mesa ' + d.comanda.mesa + '</h2>' +
      '<span class="chip empurra">' + d.pedidos.length + ' pedido(s)</span></div>' +
      '<div id="msgCaixa" style="margin-top:12px"></div>' +
      (itens.length ? itens.map(function (i) {
        return '<div class="item"><b>' + i.quantidade + '×</b> ' + esc(i.nome) +
          (i.observacao ? '<span class="nota">' + esc(i.observacao) + '</span>' : '') +
          '<span class="empurra">' + moeda(i.preco * i.quantidade) + '</span></div>';
      }).join('') : '<div class="vazio">Sem consumo.</div>') +
      '<div class="linha" style="margin-top:14px">' +
        '<div><label>Taxa de serviço' + (editavel ? '' : ' (bloqueada)') + '</label>' +
          '<select id="cxServico"' + (editavel ? '' : ' disabled') + '>' +
            '<option value="1"' + (d.comanda.servico ? ' selected' : '') + '>Cobrar ' +
              d.totais.servico_percentual + '%</option>' +
            '<option value="0"' + (d.comanda.servico ? '' : ' selected') + '>Não cobrar</option>' +
          '</select></div>' +
        '<div><label>Desconto</label><input id="cxDesconto" type="number" step="0.01" min="0" value="' +
          Number(d.comanda.desconto) + '"></div>' +
      '</div>' +
      '<div class="item" style="margin-top:12px"><span>Consumo</span>' +
        '<span class="empurra">' + moeda(d.totais.consumo) + '</span></div>' +
      '<div class="item"><span>Serviço</span><span class="empurra">' +
        moeda(d.totais.servico) + '</span></div>' +
      '<div class="item"><span>Desconto</span><span class="empurra">− ' +
        moeda(d.totais.desconto) + '</span></div>' +
      '<div class="item"><span>Já pago</span><span class="empurra">' +
        moeda(d.totais.pago) + '</span></div>' +
      '<div class="total"><span>' + (d.totais.pago > 0 ? 'Falta' : 'Total') + '</span><b>' +
        moeda(d.totais.pago > 0 ? d.totais.saldo : d.totais.total) + '</b></div>' +
    '</div>' +
    '<div class="cartao"><h2>Receber</h2>' +
      '<div class="linha">' +
        '<div><label>Forma</label><select id="cxForma">' +
          '<option value="dinheiro">Dinheiro</option>' +
          '<option value="cartao_maquina">Cartão na maquininha</option>' +
          '<option value="pix_chave">Pix na chave da casa</option>' +
        '</select></div>' +
        '<div><label>Valor recebido</label><input id="cxValor" type="number" step="0.01" min="0" value="' +
          d.totais.saldo.toFixed(2) + '"></div>' +
      '</div>' +
      '<div class="entre" style="flex-wrap:wrap">' +
        '<button class="btn" id="cxReceber">Receber</button>' +
        '<button class="btn escuro" id="cxFechar">Confirmar pagamento e encerrar mesa</button>' +
      '</div>' +
      '<p class="nota" style="margin-bottom:0">Dinheiro, maquininha e Pix na chave funcionam ' +
        'com o módulo de pagamento desligado.</p>' +
    '</div>';

  async function salvaAjuste() {
    try {
      await api('/api/comandas/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          servico: $('#cxServico').value === '1',
          desconto: Number($('#cxDesconto').value || 0),
        }),
      });
      detalheCaixa(id);
    } catch (e) { aviso('#msgCaixa', 'erro', e.message); }
  }
  $('#cxServico').onchange = salvaAjuste;
  $('#cxDesconto').onchange = salvaAjuste;

  $('#cxReceber').onclick = async function () {
    try {
      await api('/api/comandas/' + id + '/pagamentos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forma: $('#cxForma').value, valor: Number($('#cxValor').value) }),
      });
      detalheCaixa(id);
    } catch (e) { aviso('#msgCaixa', 'erro', e.message); }
  };

  $('#cxFechar').onclick = async function () {
    try {
      await fecha(false);
    } catch (e) {
      // Saldo em aberto nao e erro de sistema: e uma decisao. O servidor diz se
      // este perfil pode tomar; a tela so pergunta.
      if (e.dados && e.dados.saldo_pendente) {
        if (!e.dados.pode_perdoar) return aviso('#msgCaixa', 'erro', e.message);
        if (!confirm(e.message + '\n\nEncerrar assim mesmo, com o saldo em aberto?')) return;
        try { await fecha(true); } catch (e2) { aviso('#msgCaixa', 'erro', e2.message); }
      } else {
        aviso('#msgCaixa', 'erro', e.message);
      }
    }
  };

  async function fecha(aceita) {
    await api('/api/comandas/' + id + '/fechar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aceita_saldo_pendente: !!aceita }),
    });
    telaCaixa.atual = null;
    toast('Mesa ' + d.comanda.mesa + ' encerrada.');
    telaCaixa();
  }
}

// ------------------------------------------------------------- cardápio
async function telaCardapio() {
  var aba = telaCardapio.aba || 'produtos';
  $('#tela').innerHTML =
    '<div class="filtros">' +
      ['produtos', 'categorias', 'adicionais'].map(function (a) {
        return '<button data-a="' + a + '"' + (a === aba ? ' class="on"' : '') + '>' +
          a.charAt(0).toUpperCase() + a.slice(1) + '</button>';
      }).join('') +
    '</div><div id="abaCardapio"></div>';
  $$('[data-a]').forEach(function (b) {
    b.onclick = function () { telaCardapio.aba = b.getAttribute('data-a'); telaCardapio(); };
  });

  if (aba === 'produtos') return abaProdutos();
  if (aba === 'categorias') return abaCategorias();
  return abaAdicionais();
}

async function abaProdutos() {
  var produtos = await api('/produtos');
  // Quantidade so faz sentido com o estoque simples ligado. Com ele desligado,
  // o campo era um numero que ninguem atualizava e que nao mudava nada.
  var temEstoque = CFG['estoque.modo'] === 'simples';

  $('#abaCardapio').innerHTML =
    '<div class="cartao"><h2>Novo produto</h2><div id="msgProd"></div>' +
      '<div class="linha">' +
        '<div><label>Nome</label><input id="pNome"></div>' +
        '<div><label>Preço</label><input id="pPreco" type="number" step="0.01" min="0"></div>' +
        '<div><label>Categoria</label><input id="pCat" placeholder="bebidas, comidas…"></div>' +
        (temEstoque ? '<div><label>Quantidade</label><input id="pQtd" type="number" min="0" value="1"></div>' : '') +
      '</div>' +
      '<div style="margin-bottom:12px"><label>Descrição</label><input id="pDesc"></div>' +
      '<div style="margin-bottom:14px"><label>Imagem</label><input id="pImg" type="file" accept="image/*"></div>' +
      '<button class="btn" id="pSalvar">Cadastrar</button>' +
    '</div>' +
    '<div class="cartao"><h2>Produtos</h2><div class="rolagem"><table class="tabela">' +
      '<thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th>' +
        (temEstoque ? '<th>Estoque</th>' : '') + '<th>Disponibilidade</th><th></th></tr></thead>' +
      '<tbody>' + produtos.map(function (p) {
        return '<tr><td><b>' + esc(p.nomeproduto) + '</b>' +
            (p.descricaoproduto ? '<div class="nota">' + esc(p.descricaoproduto) + '</div>' : '') + '</td>' +
          '<td><span class="chip">' + esc(p.categoria || '—') + '</span></td>' +
          '<td>' + moeda(p.precoproduto) + '</td>' +
          (temEstoque ? '<td>' + p.quantidadeproduto + '</td>' : '') +
          '<td><button class="btn pequeno ' + (p.disponivel ? '' : 'sec') + '" ' +
            'data-disp="' + p.idnomeproduto + ':' + (p.disponivel ? '0' : '1') + '">' +
            (p.disponivel ? 'Disponível' : 'Indisponível') + '</button></td>' +
          '<td><div class="acoes">' +
            '<button class="btn sec pequeno" data-adic="' + p.idnomeproduto + '">Adicionais</button>' +
            '<button class="btn sec pequeno" data-del="' + p.idnomeproduto + '">Excluir</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div></div>';

  $('#pSalvar').onclick = async function () {
    var fd = new FormData();
    fd.append('nomeProduto', $('#pNome').value);
    fd.append('precoProduto', $('#pPreco').value);
    fd.append('descricaoProduto', $('#pDesc').value);
    fd.append('quantidadeProduto', temEstoque ? $('#pQtd').value : '0');
    fd.append('categoria', $('#pCat').value);
    if ($('#pImg').files[0]) fd.append('imagemProduto', $('#pImg').files[0]);
    this.disabled = true;
    try {
      await api('/api/cadastrarProduto', { method: 'POST', body: fd });
      abaProdutos();
    } catch (e) { aviso('#msgProd', 'erro', e.message); this.disabled = false; }
  };
  $$('[data-disp]').forEach(function (b) {
    b.onclick = async function () {
      var p = b.getAttribute('data-disp').split(':');
      await api('/produtos/' + p[0] + '/disponibilidade', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disponivel: p[1] === '1' }),
      });
      abaProdutos();
    };
  });
  $$('[data-del]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('Excluir este produto?')) return;
      try { await api('/produtos/' + b.getAttribute('data-del'), { method: 'DELETE' }); abaProdutos(); }
      catch (e) { aviso('#msgProd', 'erro', e.message); }
    };
  });
  $$('[data-adic]').forEach(function (b) {
    b.onclick = function () { gavetaAdicionais(Number(b.getAttribute('data-adic'))); };
  });
}

async function gavetaAdicionais(produtoId) {
  var lista = await api('/api/cardapio/produtos/' + produtoId + '/adicionais');
  var g = document.createElement('div');
  g.className = 'gaveta';
  g.innerHTML = '<div><header><h2>Adicionais do produto</h2>' +
    '<button class="btn sec pequeno empurra" id="x">Fechar</button></header>' +
    '<div class="cartao">' + (lista.length ? lista.map(function (a) {
      return '<label class="item" style="font-weight:400">' +
        '<input type="checkbox" value="' + a.id + '"' + (a.vinculado ? ' checked' : '') +
          ' style="width:18px;min-height:0;accent-color:var(--verde)"> ' + esc(a.nome) +
        '<span class="chip ' + (a.tipo === 'complemento' ? '' : 'verde') + '">' + a.tipo + '</span>' +
        '<span class="empurra">' + (Number(a.preco) ? moeda(a.preco) : 'sem custo') + '</span></label>';
    }).join('') : '<div class="vazio">Cadastre adicionais na aba Adicionais.</div>') +
    '</div><button class="btn largo" id="salvar">Salvar</button></div>';
  document.body.appendChild(g);
  g.onclick = function (ev) { if (ev.target === g) g.remove(); };
  $('#x', g).onclick = function () { g.remove(); };
  $('#salvar', g).onclick = async function () {
    var ids = $$('input[type=checkbox]:checked', g).map(function (c) { return Number(c.value); });
    await api('/api/cardapio/produtos/' + produtoId + '/adicionais', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adicionais: ids }),
    });
    g.remove();
    toast('Adicionais salvos.');
  };
}

async function abaCategorias() {
  var cats = await api('/api/cardapio/categorias');
  $('#abaCardapio').innerHTML = '<div class="cartao"><h2>Categorias</h2>' +
    '<p class="nota">A categoria é o que agrupa o cardápio no celular do cliente. ' +
      'Renomear aqui renomeia em todos os produtos dela.</p>' +
    '<div class="rolagem"><table class="tabela"><thead><tr><th>Categoria</th><th>Produtos</th>' +
      '<th>Disponíveis</th><th></th></tr></thead><tbody>' +
    cats.map(function (c) {
      return '<tr><td><b>' + esc(c.categoria || '— sem categoria —') + '</b></td>' +
        '<td>' + c.produtos + '</td><td>' + c.disponiveis + '</td>' +
        '<td><div class="acoes"><button class="btn sec pequeno" data-ren="' + esc(c.categoria) +
          '">Renomear</button></div></td></tr>';
    }).join('') + '</tbody></table></div></div>';

  $$('[data-ren]').forEach(function (b) {
    b.onclick = async function () {
      var velho = b.getAttribute('data-ren');
      var novo = prompt('Novo nome da categoria:', velho);
      if (!novo || novo === velho) return;
      await api('/api/cardapio/categorias/' + encodeURIComponent(velho), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: novo }),
      });
      abaCategorias();
    };
  });
}

async function abaAdicionais() {
  var lista = await api('/api/cardapio/adicionais');
  $('#abaCardapio').innerHTML =
    '<div class="cartao"><h2>Novo</h2><div id="msgAd"></div>' +
      '<div class="linha">' +
        '<div><label>Nome</label><input id="aNome"></div>' +
        '<div><label>Preço</label><input id="aPreco" type="number" step="0.01" min="0" value="0"></div>' +
        '<div><label>Tipo</label><select id="aTipo">' +
          '<option value="adicional">Adicional (soma no preço)</option>' +
          '<option value="complemento">Complemento (sem custo)</option>' +
        '</select></div>' +
      '</div><button class="btn" id="aSalvar">Criar</button>' +
    '</div>' +
    '<div class="cartao"><h2>Adicionais e complementos</h2>' +
      '<div class="rolagem"><table class="tabela"><thead><tr><th>Nome</th><th>Tipo</th><th>Preço</th>' +
        '<th>Produtos</th><th></th></tr></thead><tbody>' +
      (lista.length ? lista.map(function (a) {
        return '<tr><td><b>' + esc(a.nome) + '</b></td>' +
          '<td><span class="chip ' + (a.tipo === 'complemento' ? '' : 'verde') + '">' + a.tipo + '</span></td>' +
          '<td>' + (Number(a.preco) ? moeda(a.preco) : '—') + '</td>' +
          '<td>' + a.produtos + '</td>' +
          '<td><div class="acoes">' +
            '<button class="btn sec pequeno" data-at="' + a.id + ':' + (a.ativo ? '0' : '1') + '">' +
              (a.ativo ? 'Ativo' : 'Inativo') + '</button>' +
            '<button class="btn sec pequeno" data-rm="' + a.id + '">Excluir</button>' +
          '</div></td></tr>';
      }).join('') : '<tr><td colspan="5"><div class="vazio">Nada cadastrado.</div></td></tr>') +
      '</tbody></table></div></div>';

  $('#aSalvar').onclick = async function () {
    try {
      await api('/api/cardapio/adicionais', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: $('#aNome').value, preco: Number($('#aPreco').value || 0), tipo: $('#aTipo').value,
        }),
      });
      abaAdicionais();
    } catch (e) { aviso('#msgAd', 'erro', e.message); }
  };
  $$('[data-at]').forEach(function (b) {
    b.onclick = async function () {
      var p = b.getAttribute('data-at').split(':');
      await api('/api/cardapio/adicionais/' + p[0], {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: p[1] === '1' }),
      });
      abaAdicionais();
    };
  });
  $$('[data-rm]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('Excluir? Pedidos antigos mantêm o valor já cobrado.')) return;
      await api('/api/cardapio/adicionais/' + b.getAttribute('data-rm'), { method: 'DELETE' });
      abaAdicionais();
    };
  });
}

// ----------------------------------------------------------- mesas & QR
async function telaMesas() {
  var mesas = await api('/api/mesas');
  var mostraTecnico = CFG['dev.mostrar_enderecos'] === 'true';

  $('#tela').innerHTML =
    '<div class="cartao"><div class="entre" style="flex-wrap:wrap">' +
      '<h2>Mesas</h2>' +
      '<div class="acoes empurra">' +
        '<button class="btn sec" id="qrTodas">Gerar QR para todas</button>' +
        '<button class="btn sec" id="imprimirTodos">Imprimir todos</button>' +
        '<button class="btn" id="novaMesa">+ Nova mesa</button>' +
      '</div></div>' +
      '<div id="msgMesa" style="margin-top:12px"></div>' +
      '<div class="rolagem"><table class="tabela">' +
        '<thead><tr><th>Mesa</th><th>Área</th><th>Status</th><th>QR</th><th></th></tr></thead>' +
        '<tbody>' + (mesas.length ? mesas.map(function (m) {
          return '<tr><td><b>' + String(m.numero).padStart(2, '0') + '</b></td>' +
            '<td>' + esc(m.area || '') + '</td>' +
            '<td><span class="chip ' + (m.comanda_id ? 'verde' : '') + '">' +
              (m.comanda_id ? 'Ocupada' : 'Livre') + '</span></td>' +
            '<td><span class="chip ' + (m.qr_token ? 'verde' : 'vermelho') + '">' +
              (m.qr_token ? 'Ativo' : 'Sem QR') + '</span></td>' +
            '<td><div class="acoes">' +
              (m.qr_token
                ? '<button class="btn sec pequeno" data-ver="' + m.id + '">Ver</button>' +
                  '<button class="btn sec pequeno" data-imp="' + m.id + '">Imprimir</button>' +
                  '<button class="btn sec pequeno" data-ger="' + m.id + '">Regenerar</button>' +
                  '<button class="btn sec pequeno" data-rev="' + m.id + '">Excluir QR</button>'
                : '<button class="btn pequeno" data-ger="' + m.id + '">Gerar QR</button>') +
            '</div></td></tr>';
        }).join('') : '<tr><td colspan="5"><div class="vazio">Nenhuma mesa. O QR precisa de uma.</div></td></tr>') +
      '</tbody></table></div>' +
    '</div>' +
    (mostraTecnico
      ? '<div class="cartao"><h2>Endereços (modo desenvolvimento)</h2>' +
          '<p class="nota">Isto aparece porque <b>Configurações → Desenvolvimento</b> está ligado. ' +
            'Em operação normal fica escondido.</p>' +
          '<div class="linha"><div><label>Tela do cliente</label><input readonly value="' +
            esc(CFG['cliente.url'] || '') + '"></div>' +
          '<div><label>API vista pelo celular</label><input readonly value="' +
            esc(CFG['api.publica'] || '(o navegador decide)') + '"></div></div></div>'
      : '');

  $('#novaMesa').onclick = async function () {
    var numero = prompt('Número da mesa:');
    if (!numero) return;
    var area = prompt('Área (Salão, Deck, Praia…):', 'Salão') || 'Salão';
    try {
      await api('/api/mesas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero: Number(numero), area: area }),
      });
      telaMesas();
    } catch (e) { aviso('#msgMesa', 'erro', e.message); }
  };

  $('#qrTodas').onclick = async function () {
    var sem = mesas.filter(function (m) { return !m.qr_token; });
    if (!sem.length) return aviso('#msgMesa', 'ok', 'Todas as mesas já têm QR.');
    if (!confirm('Gerar QR para ' + sem.length + ' mesa(s) sem código?')) return;
    for (var i = 0; i < sem.length; i++) {
      await api('/api/mesas/' + sem[i].id + '/qrcode', { method: 'POST' });
    }
    telaMesas();
  };

  $('#imprimirTodos').onclick = async function () {
    var com = mesas.filter(function (m) { return m.qr_token; });
    if (!com.length) return aviso('#msgMesa', 'erro', 'Nenhuma mesa com QR.');
    var paginas = [];
    for (var i = 0; i < com.length; i++) {
      var svg = await (await fetch(API + '/api/mesas/' + com[i].id + '/qrcode.svg',
        { headers: cabecalhos() })).text();
      paginas.push(folhaQr(com[i].numero, svg));
    }
    imprime(paginas.join(''));
  };

  $$('[data-ger]').forEach(function (b) {
    b.onclick = async function () {
      var id = Number(b.getAttribute('data-ger'));
      var tinha = mesas.filter(function (m) { return m.id === id; })[0].qr_token;
      if (tinha && !confirm('Gerar outro QR faz o adesivo atual parar de funcionar. Continuar?')) return;
      var r = await api('/api/mesas/' + id + '/qrcode', { method: 'POST' });
      telaMesas();
      mostraQr(r.mesa, r.svg, r.url);
    };
  });
  $$('[data-rev]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('Excluir o QR desta mesa? O adesivo impresso deixa de abrir.')) return;
      var r = await api('/api/mesas/' + b.getAttribute('data-rev') + '/qrcode', { method: 'DELETE' });
      telaMesas();
      aviso('#msgMesa', 'ok', r.message);
    };
  });
  $$('[data-ver]').forEach(function (b) {
    b.onclick = async function () {
      var m = mesas.filter(function (x) { return x.id === Number(b.getAttribute('data-ver')); })[0];
      var svg = await (await fetch(API + '/api/mesas/' + m.id + '/qrcode.svg',
        { headers: cabecalhos() })).text();
      mostraQr(m, svg, null);
    };
  });
  $$('[data-imp]').forEach(function (b) {
    b.onclick = async function () {
      var m = mesas.filter(function (x) { return x.id === Number(b.getAttribute('data-imp')); })[0];
      var svg = await (await fetch(API + '/api/mesas/' + m.id + '/qrcode.svg',
        { headers: cabecalhos() })).text();
      imprime(folhaQr(m.numero, svg));
    };
  });
}

function folhaQr(numero, svg) {
  return '<section><div class="casa">' + esc(CFG['geral.nome'] || 'App-Venda') + '</div>' +
    '<h1>Mesa ' + numero + '</h1>' + svg +
    '<p>Escaneie para fazer seu pedido</p></section>';
}

function imprime(html) {
  var j = window.open('', '_blank');
  j.document.write('<!doctype html><meta charset="utf-8"><title>QR das mesas</title><style>' +
    'body{font:16px system-ui;margin:0}' +
    'section{height:100vh;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;page-break-after:always;text-align:center}' +
    '.casa{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#6B6E75}' +
    'h1{font-size:46px;margin:6px 0 18px}svg{width:300px;height:300px}' +
    'p{color:#6B6E75;margin-top:18px}</style>' + html);
  j.document.close();
  j.focus();
  j.print();
}

function mostraQr(mesa, svg, url) {
  var endereco = url || ((CFG['cliente.url'] || '') + '?t=' + mesa.qr_token +
    (CFG['api.publica'] ? '&api=' + encodeURIComponent(CFG['api.publica']) : ''));
  var g = document.createElement('div');
  g.className = 'gaveta';
  g.innerHTML = '<div><header><h2>QR da mesa ' + mesa.numero + '</h2>' +
      '<button class="btn sec pequeno empurra" id="x">Fechar</button></header>' +
    '<div class="cartao" style="text-align:center">' +
      '<div class="nota" style="letter-spacing:.14em;text-transform:uppercase">' +
        esc(CFG['geral.nome'] || 'App-Venda') + '</div>' +
      '<h1 style="margin:4px 0 12px">Mesa ' + mesa.numero + '</h1>' +
      '<div id="desenho" style="background:#fff;border-radius:12px;padding:12px;display:inline-block"></div>' +
      '<p class="nota">Escaneie para fazer seu pedido</p>' +
    '</div>' +
    '<div class="cartao"><div class="acoes" style="justify-content:flex-start">' +
      '<button class="btn sec" id="png">Baixar PNG</button>' +
      '<button class="btn sec" id="imp">Imprimir / salvar PDF</button>' +
      '<button class="btn sec" id="abrir">Abrir a tela do cliente</button>' +
    '</div>' +
    (CFG['dev.mostrar_enderecos'] === 'true'
      ? '<div style="margin-top:12px"><label>Endereço dentro do QR</label>' +
        '<input readonly value="' + esc(endereco) + '" onclick="this.select()"></div>' : '') +
    '<p class="nota" style="margin-bottom:0">Se o adesivo for fotografado por alguém de fora, ' +
      'é só <b>regenerar</b>: o antigo para de funcionar na hora.</p></div></div>';
  document.body.appendChild(g);
  // O SVG vem da biblioteca de QR a partir da URL -- nao e texto digitado.
  $('#desenho', g).innerHTML = svg;
  g.onclick = function (ev) { if (ev.target === g) g.remove(); };
  $('#x', g).onclick = function () { g.remove(); };
  $('#abrir', g).onclick = function () { window.open(endereco, '_blank'); };
  $('#imp', g).onclick = function () { imprime(folhaQr(mesa.numero, svg)); };
  // PNG sai de um canvas: o navegador ja sabe rasterizar SVG, nao precisa de
  // biblioteca. PDF fica por conta do "Salvar como PDF" da janela de impressao.
  $('#png', g).onclick = function () {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = c.height = 900;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 900, 900);
      ctx.drawImage(img, 50, 50, 800, 800);
      var a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = 'mesa-' + mesa.numero + '.png';
      a.click();
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  };
}

// ---------------------------------------------------------- relatórios
async function telaRelatorios() {
  if (CFG['financeiro.ativo'] !== 'true') {
    return $('#tela').innerHTML = '<div class="cartao"><div class="vazio">' +
      'O módulo de relatórios está desligado em Configurações.</div></div>';
  }
  var r, formas, top, horas;
  try {
    r = await api('/api/financeiro/resumo');
    formas = await api('/api/financeiro/formas');
    top = await api('/api/financeiro/mais-vendidos');
    horas = await api('/api/financeiro/por-hora');
  } catch (e) { return aviso('#tela', 'erro', e.message); }

  var cancelados = await api('/api/financeiro/transacoes').then(function () { return null; })
    .catch(function () { return null; });
  var pico = Math.max.apply(null, horas.map(function (h) { return Number(h.bruto); }).concat([1]));

  $('#tela').innerHTML =
    '<div class="grade g4">' +
      cartaoNumero('Faturamento', moeda(r.bruto), 'hoje') +
      cartaoNumero('Pedidos', r.pedidos, r.comandas + ' mesas atendidas') +
      cartaoNumero('Ticket médio', moeda(r.ticket_medio), 'por mesa') +
      cartaoNumero('Preparo médio', r.preparo_medio_min + ' min', 'do pagamento à entrega') +
    '</div>' +
    '<div class="grade g2" style="align-items:start">' +
      '<div class="cartao"><h2>Faturamento por hora</h2>' +
        (horas.length
          ? '<div style="display:flex;align-items:flex-end;gap:10px;height:160px">' +
            horas.map(function (h) {
              return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px">' +
                '<div style="width:100%;background:var(--verde);border-radius:5px 5px 0 0;height:' +
                  Math.max(4, (Number(h.bruto) / pico) * 130) + 'px"></div>' +
                '<span class="nota">' + h.hora + 'h</span></div>';
            }).join('') + '</div>'
          : '<div class="vazio">Sem movimento hoje.</div>') +
      '</div>' +
      '<div class="cartao"><h2>Formas de pagamento</h2>' +
        (formas.length ? formas.map(function (f) {
          return '<div class="item"><span class="chip ' +
            (f.origem === 'app' ? 'verde' : '') + '">' + esc(f.forma) + '</span>' +
            '<span class="nota">' + f.qtd + '×</span>' +
            '<span class="empurra"><b>' + moeda(f.bruto) + '</b>' +
            (Number(f.taxas) ? ' <span class="nota">− ' + moeda(f.taxas) + ' taxa</span>' : '') +
            '</span></div>';
        }).join('') : '<div class="vazio">Nenhum pagamento hoje.</div>') +
        '<div class="total"><span>Líquido</span><b>' + moeda(r.liquido) + '</b></div>' +
      '</div>' +
    '</div>' +
    '<div class="cartao"><h2>Mais vendidos</h2>' +
      (top.length ? top.map(function (t, n) {
        return '<div class="item"><b style="color:var(--suave);min-width:22px">' + (n + 1) + '</b>' +
          esc(t.nome) + '<span class="empurra">' + t.unidades + ' un · ' + moeda(t.total) + '</span></div>';
      }).join('') : '<div class="vazio">Nada vendido hoje.</div>') +
    '</div>';
}

function cartaoNumero(rotulo, valor, nota) {
  return '<div class="cartao"><div class="nota">' + rotulo + '</div>' +
    '<div style="font-size:27px;font-weight:800;margin-top:4px">' + valor + '</div>' +
    '<div class="nota">' + nota + '</div></div>';
}

// ------------------------------------------------------------- usuários
async function telaUsuarios() {
  var d;
  try { d = await api('/api/usuarios'); } catch (e) { return aviso('#tela', 'erro', e.message); }

  $('#tela').innerHTML =
    '<div class="cartao"><h2>Novo usuário</h2><div id="msgU"></div>' +
      '<div class="linha">' +
        '<div><label>Login</label><input id="uLogin"></div>' +
        '<div><label>Nome</label><input id="uNome"></div>' +
        '<div><label>Senha</label><input id="uSenha" type="password"></div>' +
        '<div><label>Perfil</label><select id="uPerfil">' +
          d.perfis.map(function (p) { return '<option value="' + p + '">' + p + '</option>'; }).join('') +
        '</select></div>' +
      '</div><button class="btn" id="uCriar">Criar</button>' +
      '<p class="nota">O que cada perfil enxerga: ' +
        d.perfis.map(function (p) { return '<b>' + p + '</b> ' + d.areas[p].join(', '); }).join(' · ') +
      '</p>' +
    '</div>' +
    '<div class="cartao"><h2>Usuários</h2><div class="rolagem"><table class="tabela">' +
      '<thead><tr><th>Login</th><th>Nome</th><th>Perfil</th><th>Status</th><th></th></tr></thead><tbody>' +
      d.usuarios.map(function (u) {
        return '<tr><td><b>' + esc(u.login) + '</b></td><td>' + esc(u.nome || '—') + '</td>' +
          '<td><select data-perfil="' + u.id + '" style="min-height:34px;padding:4px 8px">' +
            d.perfis.map(function (p) {
              return '<option' + (p === u.perfil ? ' selected' : '') + '>' + p + '</option>';
            }).join('') + '</select></td>' +
          '<td><span class="chip ' + (u.ativo ? 'verde' : 'vermelho') + '">' +
            (u.ativo ? 'Ativo' : 'Desativado') + '</span></td>' +
          '<td><div class="acoes">' +
            '<button class="btn sec pequeno" data-senha="' + u.id + '">Redefinir senha</button>' +
            '<button class="btn sec pequeno" data-ativo="' + u.id + ':' + (u.ativo ? '0' : '1') + '">' +
              (u.ativo ? 'Desativar' : 'Reativar') + '</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div></div>';

  $('#uCriar').onclick = async function () {
    try {
      await api('/api/usuarios', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: $('#uLogin').value, nome: $('#uNome').value,
          senha: $('#uSenha').value, perfil: $('#uPerfil').value,
        }),
      });
      telaUsuarios();
    } catch (e) { aviso('#msgU', 'erro', e.message); }
  };
  $$('[data-perfil]').forEach(function (s) {
    s.onchange = async function () {
      try {
        await api('/api/usuarios/' + s.getAttribute('data-perfil'), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perfil: s.value }),
        });
        telaUsuarios();
      } catch (e) { aviso('#msgU', 'erro', e.message); telaUsuarios(); }
    };
  });
  $$('[data-ativo]').forEach(function (b) {
    b.onclick = async function () {
      var p = b.getAttribute('data-ativo').split(':');
      try {
        await api('/api/usuarios/' + p[0], {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ativo: p[1] === '1' }),
        });
        telaUsuarios();
      } catch (e) { aviso('#msgU', 'erro', e.message); }
    };
  });
  $$('[data-senha]').forEach(function (b) {
    b.onclick = async function () {
      var nova = prompt('Nova senha (mínimo 6 caracteres):');
      if (!nova) return;
      try {
        var r = await api('/api/usuarios/' + b.getAttribute('data-senha') + '/senha', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senha: nova }),
        });
        aviso('#msgU', 'ok', r.message);
      } catch (e) { aviso('#msgU', 'erro', e.message); }
    };
  });
}

// --------------------------------------------------------- configurações
async function telaConfig() {
  var aba = telaConfig.aba || 'geral';
  var abas = ['geral', 'operação', 'pagamento', 'estoque', 'relatórios', 'desenvolvimento'];
  $('#tela').innerHTML = '<div class="filtros">' + abas.map(function (a) {
      return '<button data-ac="' + a + '"' + (a === aba ? ' class="on"' : '') + '>' +
        a.charAt(0).toUpperCase() + a.slice(1) + '</button>';
    }).join('') + '</div><div id="msgC"></div><div id="abaCfg"></div>';
  $$('[data-ac]').forEach(function (b) {
    b.onclick = function () { telaConfig.aba = b.getAttribute('data-ac'); telaConfig(); };
  });

  function campo(rotulo, chave, opcoes, nota) {
    return '<div><label>' + rotulo + '</label><select data-k="' + chave + '">' +
      opcoes.map(function (o) {
        return '<option value="' + o[0] + '"' + (CFG[chave] === o[0] ? ' selected' : '') + '>' +
          o[1] + '</option>';
      }).join('') + '</select>' + (nota ? '<p class="nota">' + nota + '</p>' : '') + '</div>';
  }
  function texto(rotulo, chave, nota, tipo) {
    return '<div><label>' + rotulo + '</label><input data-k="' + chave + '"' +
      (tipo ? ' type="' + tipo + '"' : '') + ' value="' + esc(CFG[chave] || '') + '">' +
      (nota ? '<p class="nota">' + nota + '</p>' : '') + '</div>';
  }
  var liga = [['true', 'Ligado'], ['false', 'Desligado']];

  var html = '';
  if (aba === 'geral') {
    html = '<div class="cartao"><h2>Geral</h2><div class="linha">' +
      texto('Nome do estabelecimento', 'geral.nome',
        'Aparece na tela do cliente e no QR impresso.') +
      '</div></div>';
  }
  if (aba === 'operação') {
    html = '<div class="cartao"><h2>Operação</h2><div class="linha">' +
      campo('Quando o cliente paga', 'pagamento.modo', [
        ['fechamento', 'No fechamento (padrão)'],
        ['antecipado', 'Antes do pedido'],
        ['ambos', 'Permitir os dois'],
      ], 'Define o que libera a cozinha: a confirmação do pedido ou o pagamento.') +
      campo('Permitir fechamento pelo cliente', 'operacao.cliente_fecha', liga,
        'O botão “Solicitar fechamento” no celular da mesa.') +
      campo('Permitir garçom adicionar pedido', 'operacao.garcom_lanca', liga) +
      '</div><div class="linha" style="margin-top:4px">' +
      campo('Taxa de serviço', 'servico.ativo', liga, 'Desligada, a linha some da conta.') +
      texto('Percentual', 'servico.percentual', null, 'number') +
      campo('Caixa pode remover a taxa', 'servico.editavel_no_caixa', liga) +
      '</div><div class="linha" style="margin-top:4px">' +
      texto('Cozinha: atenção a partir de (min)', 'cozinha.atencao_min', null, 'number') +
      texto('Cozinha: atraso a partir de (min)', 'cozinha.atraso_min', null, 'number') +
      '</div></div>';
  }
  if (aba === 'pagamento') {
    html = '<div class="cartao"><h2>Pagamento integrado</h2><div class="linha">' +
      campo('Pix e cartão no app', 'pagamento.integrado', liga,
        'Desligado, o caixa continua recebendo dinheiro, maquininha e Pix na chave da casa.') +
      '</div><p class="nota">Não há adquirente conectada: a aprovação é simulada no servidor ' +
      '(<code>config/modules/pagamento.js</code>). Trocar por um provedor real mexe só nessa função.</p></div>';
  }
  if (aba === 'estoque') {
    html = '<div class="cartao"><h2>Estoque</h2><div class="linha">' +
      campo('Controle', 'estoque.modo', [
        ['desligado', 'Desligado — só disponível/indisponível'],
        ['simples', 'Simples — unidades do prato'],
        ['ingrediente', 'Avançado — ficha técnica por ingrediente'],
      ], 'Em qualquer modo, o que fica sem estoque some do cardápio do cliente.') +
      '</div></div>';
  }
  if (aba === 'relatórios') {
    html = '<div class="cartao"><h2>Relatórios</h2><div class="linha">' +
      campo('Relatórios financeiros', 'financeiro.ativo', liga,
        'Só leitura: nunca bloqueia pedido nem fechamento.') +
      '</div></div>';
  }
  if (aba === 'desenvolvimento') {
    html = '<div class="cartao"><h2>Desenvolvimento</h2>' +
      '<p class="nota">Endereços técnicos só aparecem nas telas quando isto está ligado. ' +
        'Em produção, deixe desligado.</p><div class="linha">' +
      campo('Mostrar endereços nas telas', 'dev.mostrar_enderecos', liga) +
      texto('URL da tela do cliente', 'cliente.url', 'É o que vai dentro do QR.') +
      texto('API vista pelo celular', 'api.publica',
        'No celular, localhost é o próprio celular: use o IP da máquina na rede.') +
      '</div></div>';
  }

  $('#abaCfg').innerHTML = html + '<button class="btn" id="salvarCfg">Salvar</button>';
  $('#salvarCfg').onclick = async function () {
    var corpo = {};
    $$('[data-k]').forEach(function (el) { corpo[el.getAttribute('data-k')] = el.value; });
    try {
      CFG = await api('/api/configuracoes', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      aviso('#msgC', 'ok', 'Salvo. Vale para o próximo pedido, sem reiniciar nada.');
      $('#casa').textContent = CFG['geral.nome'] || 'painel';
    } catch (e) { aviso('#msgC', 'erro', e.message); }
  };
}

// ------------------------------------------------------------ chamados
async function carregaChamados() {
  if (AREAS.indexOf('salao') < 0) return;
  try { CHAMADOS = await api('/api/chamados'); } catch (e) { CHAMADOS = []; }
  pintaMenu();
}

// --------------------------------------------------------------- rotear
var PINTA = {
  salao: telaSalao, cozinha: telaCozinha, caixa: telaCaixa, cardapio: telaCardapio,
  mesas: telaMesas, relatorios: telaRelatorios, usuarios: telaUsuarios, config: telaConfig,
};

async function rotear() {
  var t = telaAtual();
  if (AREAS.indexOf(t.area) < 0) {
    $('#titulo').textContent = 'Sem acesso';
    $('#tela').innerHTML = '<div class="cartao"><div class="vazio">' +
      'Seu perfil não tem acesso a esta área.</div></div>';
    return;
  }
  if (pararRelogio) { clearInterval(pararRelogio); pararRelogio = null; }
  $('#titulo').textContent = t.titulo;
  $('#tela').innerHTML = '<div class="vazio">Carregando…</div>';
  pintaMenu();
  try { await PINTA[t.id](); } catch (e) { aviso('#tela', 'erro', e.message); }
}

window.addEventListener('hashchange', rotear);

// ------------------------------------------------------------ inicio
(async function () {
  if (!SESSAO) return location.replace('login.html');
  try {
    var s = await api('/api/sessao');
    SESSAO = { token: SESSAO.token, usuario: s.usuario, areas: s.areas };
    guardaSessao(SESSAO);
    AREAS = s.areas;
  } catch (e) {
    esqueceSessao();
    return location.replace('login.html');
  }

  try { CFG = await api('/api/configuracoes'); } catch (e) { CFG = {}; }

  $('#casa').textContent = CFG['geral.nome'] || 'painel';
  $('#quemNome').textContent = SESSAO.usuario.nome || SESSAO.usuario.login;
  $('#quemPerfil').textContent = SESSAO.usuario.perfil;
  $('#avatar').textContent = (SESSAO.usuario.login || '?').slice(0, 2).toUpperCase();
  $('#sair').onclick = async function () {
    try { await api('/api/sessao', { method: 'DELETE' }); } catch (e) { /* segue */ }
    esqueceSessao();
    location.replace('login.html');
  };

  await carregaChamados();
  await rotear();

  // Tempo real: a tela aberta se atualiza sozinha quando algo acontece do outro
  // lado. Sem isto, a cozinha dependia de alguem clicar em Atualizar.
  pararFluxo = ouveFluxo('/api/stream', function (ev) {
    if (ev.evento === 'chamado:aberto') {
      carregaChamados();
      toast('Uma mesa solicitou atendimento.', {
        rotulo: 'Ver salão', ao: function () { location.hash = '#/salao'; },
      });
    }
    if (ev.evento.indexOf('chamado:') === 0) carregaChamados();

    var t = telaAtual().id;
    var interessa = {
      cozinha: /^pedido:/, salao: /^(pedido|comanda|chamado):/,
      caixa: /^(pedido|comanda|pagamento)/, relatorios: /^(pagamento|comanda:fechada)/,
    }[t];
    if (interessa && interessa.test(ev.evento)) PINTA[t]();
  });

  window.addEventListener('beforeunload', function () { if (pararFluxo) pararFluxo(); });
})();
