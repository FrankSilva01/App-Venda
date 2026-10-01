// NUCLEO: QR -> pedido -> cozinha -> comanda -> caixa -> fechamento.
//
// Este arquivo funciona com pagamento, estoque e financeiro TODOS desligados.
// Por isso ele nao da require em nenhum deles -- so em banco, configuracao e
// barramento. Quem depende de quem:
//
//     modules/pagamento.js  ->  fluxo (chama liberarPedido)
//     modules/estoque.js    ->  eventos (escuta pedido:liberado)
//     modules/financeiro.js ->  banco (so le)
//     fluxo.js              ->  ninguem
//
// A seta nunca aponta do nucleo para um modulo. E isso que deixa desligar.
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { query, transacao } = require('../server/dbConnection');
const cfg = require('../server/configuracoes');
const eventos = require('../server/eventos');
const auditoria = require('../server/auditoria');

const router = express.Router();

function erro(res, e, msg) {
  console.error(msg + ':', e.message);
  res.status(500).json({ error: msg });
}

const dinheiro = (v) => Math.round(Number(v || 0) * 100) / 100;

// ------------------------------------------------------------------ totais
// Uma unica funcao calcula o total em todo lugar (comanda, caixa, fechamento).
// Dois calculos do mesmo total e a forma mais rapida de a conta do cliente nao
// bater com a do caixa.
async function totalComanda(comandaId) {
  const c = await query('SELECT servico, desconto FROM comandas WHERE id = $1', [comandaId]);
  if (!c.rows.length) return null;

  // Pedido cancelado nao entra. O resto entra, inclusive o que ainda nao foi
  // para a cozinha -- o cliente ja se comprometeu com ele.
  const i = await query(
    `SELECT COALESCE(SUM(it.preco * it.quantidade), 0) AS consumo
       FROM pedido_itens it
       JOIN pedidos p ON p.id = it.pedido_id
      WHERE p.comanda_id = $1 AND p.status <> 'cancelado'`,
    [comandaId]
  );
  const p = await query(
    'SELECT COALESCE(SUM(valor), 0) AS pago FROM pagamentos WHERE comanda_id = $1',
    [comandaId]
  );

  const pct = Number(await cfg.ler('servico.percentual'));
  // Duas chaves, e as duas tem de estar ligadas: a da casa (cobra servico?) e a
  // da comanda (esta mesa paga?). O caixa desliga na comanda quando o cliente
  // pede para tirar; a configuracao desliga para a casa inteira.
  const cobraServico = (await cfg.ligado('servico.ativo')) && c.rows[0].servico;
  const consumo = dinheiro(i.rows[0].consumo);
  const servico = cobraServico ? dinheiro(consumo * (pct / 100)) : 0;
  const desconto = dinheiro(c.rows[0].desconto);
  const total = dinheiro(consumo + servico - desconto);
  const pago = dinheiro(p.rows[0].pago);

  return {
    consumo,
    servico,
    servico_cobrado: cobraServico,
    servico_percentual: pct,
    desconto,
    total,
    pago,
    saldo: dinheiro(total - pago),
  };
}

// --------------------------------------------------------- liberar pedido
// Porta de entrada da cozinha. O nucleo chama direto; o modulo de pagamento
// chama daqui quando aprova. Idempotente de proposito: webhook de adquirente
// repete, e repetir nao pode fazer o pedido entrar duas vezes na fila.
async function liberarPedido(pedidoId, motivo) {
  const r = await query(
    `UPDATE pedidos SET status = 'novo', liberado_em = now()
      WHERE id = $1 AND status = 'aguardando'
      RETURNING *`,
    [pedidoId]
  );
  if (!r.rows.length) return null;

  const itens = await query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);
  const pedido = r.rows[0];
  eventos.emitir('pedido:liberado', { pedido, itens: itens.rows, motivo: motivo || 'confirmado' });
  return pedido;
}

// ----------------------------------------------------------------- mesas
router.get('/mesas', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.*, c.id AS comanda_id, c.aberta_em
         FROM mesas m
         LEFT JOIN comandas c ON c.mesa_id = m.id AND c.status = 'aberta'
        ORDER BY m.numero`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar as mesas'); }
});

router.post('/mesas', async (req, res) => {
  const { numero, apelido, area } = req.body || {};
  if (!numero) return res.status(400).json({ message: 'Informe o número da mesa.' });
  try {
    const r = await query(
      `INSERT INTO mesas (numero, apelido, area) VALUES ($1, $2, COALESCE($3, 'Salão'))
       RETURNING *`,
      [Number(numero), apelido || null, (area || '').trim() || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ message: 'Essa mesa já existe.' });
    erro(res, e, 'Erro ao criar a mesa');
  }
});

router.patch('/mesas/:id', async (req, res) => {
  const { apelido, area, ativa } = req.body || {};
  try {
    const r = await query(
      `UPDATE mesas SET apelido = COALESCE($2, apelido),
                        area    = COALESCE($3, area),
                        ativa   = COALESCE($4, ativa)
        WHERE id = $1 RETURNING *`,
      [Number(req.params.id),
       apelido === undefined ? null : apelido,
       area === undefined ? null : String(area).trim(),
       ativa === undefined ? null : !!ativa]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Mesa não encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao alterar a mesa'); }
});

// --------------------------------------------------------- QR da mesa
// URL que vai dentro do QR. Montada no servidor porque so ele sabe o endereco
// configurado da tela do cliente -- o adesivo precisa funcionar em qualquer
// celular, nao so no navegador de quem gerou.
async function urlDoQr(token) {
  const base = await cfg.ler('cliente.url');
  const api = await cfg.ler('api.publica');
  return base + '?t=' + token + (api ? '&api=' + encodeURIComponent(api) : '');
}

// 12 caracteres de base64url (72 bits). Nao e sequencial de proposito: token
// previsivel e o mesmo problema do numero da mesa na URL.
const novoToken = () => crypto.randomBytes(9).toString('base64url');

// Gera ou REGENERA. Regerar troca o token, e com isso o adesivo antigo para de
// funcionar na hora -- e exatamente o que se quer quando a foto do QR vazou.
router.post('/mesas/:id/qrcode', async (req, res) => {
  try {
    const r = await query(
      'UPDATE mesas SET qr_token = $2, qr_criado_em = now() WHERE id = $1 RETURNING *',
      [Number(req.params.id), novoToken()]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Mesa não encontrada.' });
    const url = await urlDoQr(r.rows[0].qr_token);
    res.status(201).json({ mesa: r.rows[0], url, svg: await QRCode.toString(url, { type: 'svg', margin: 1 }) });
  } catch (e) { erro(res, e, 'Erro ao gerar o QR code'); }
});

router.delete('/mesas/:id/qrcode', async (req, res) => {
  try {
    const r = await query(
      'UPDATE mesas SET qr_token = NULL, qr_criado_em = NULL WHERE id = $1 RETURNING *',
      [Number(req.params.id)]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Mesa não encontrada.' });
    // A mesa continua existindo e atendendo pelo caixa: quem morre e o adesivo.
    res.json({ mesa: r.rows[0], message: 'QR code revogado. O adesivo antigo não abre mais nada.' });
  } catch (e) { erro(res, e, 'Erro ao revogar o QR code'); }
});

// SVG para imprimir e colar na mesa. Sem PNG: SVG imprime nitido em qualquer
// tamanho, e QR borrado e QR que o celular nao le.
router.get('/mesas/:id/qrcode.svg', async (req, res) => {
  try {
    const m = await query('SELECT qr_token FROM mesas WHERE id = $1', [Number(req.params.id)]);
    if (!m.rows.length || !m.rows[0].qr_token) {
      return res.status(404).json({ message: 'Essa mesa ainda não tem QR code.' });
    }
    const svg = await QRCode.toString(await urlDoQr(m.rows[0].qr_token), { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  } catch (e) { erro(res, e, 'Erro ao desenhar o QR code'); }
});

// O que a tela do cliente carrega. Tudo numa resposta so: cardapio, conta da
// mesa e os pedidos em andamento -- o celular na mesa costuma estar num 4G ruim,
// e tres chamadas sao tres chances de falhar.
async function visaoDaMesa(mesa) {
  const prod = await query(
    'SELECT * FROM produtos WHERE disponivel ORDER BY categoria, nomeProduto'
  );
  // Adicionais de todos os produtos numa consulta: a tela do cliente abre o
  // detalhe do item sem ir ao servidor de novo.
  const adic = await query(
    `SELECT pa.produto_id, a.id, a.nome, a.preco, a.tipo
       FROM produto_adicionais pa JOIN adicionais a ON a.id = pa.adicional_id
      WHERE a.ativo ORDER BY a.tipo, a.nome`
  );
  prod.rows.forEach((p) => {
    p.adicionais = adic.rows.filter((a) => a.produto_id === p.idnomeproduto);
  });
  const comanda = await query(
    "SELECT * FROM comandas WHERE mesa_id = $1 AND status = 'aberta'", [mesa.id]
  );

  let pedidos = [];
  let totais = null;
  if (comanda.rows.length) {
    const ps = await query(
      "SELECT * FROM pedidos WHERE comanda_id = $1 AND status <> 'cancelado' ORDER BY id",
      [comanda.rows[0].id]
    );
    const itens = await query(
      `SELECT it.* FROM pedido_itens it JOIN pedidos p ON p.id = it.pedido_id
        WHERE p.comanda_id = $1 ORDER BY it.id`,
      [comanda.rows[0].id]
    );
    const comExtras = await comAdicionais(itens.rows);
    pedidos = ps.rows.map((p) =>
      Object.assign(p, { itens: comExtras.filter((i) => i.pedido_id === p.id) }));
    totais = await totalComanda(comanda.rows[0].id);
  }

  const modo = await cfg.ler('pagamento.modo');
  const integrado = await cfg.ligado('pagamento.integrado');

  const chamados = await query(
    "SELECT id, tipo, status FROM chamados WHERE mesa_id = $1 AND status <> 'resolvido'",
    [mesa.id]
  );

  return {
    estabelecimento: await cfg.ler('geral.nome'),
    mesa: { id: mesa.id, numero: mesa.numero, apelido: mesa.apelido, area: mesa.area },
    chamados: chamados.rows,
    cliente_pode_fechar: await cfg.ligado('operacao.cliente_fecha'),
    produtos: prod.rows,
    comanda: comanda.rows[0] || null,
    pedidos,
    totais,
    // A tela do cliente nao conhece a regra: ela pergunta quais botoes existem.
    pagamento: {
      modo,
      pode_pagar_agora: integrado && (modo === 'antecipado' || modo === 'ambos'),
      exige_pagar_agora: integrado && modo === 'antecipado',
    },
  };
}

// Entrada do cliente: so o token do QR. Nao aceita numero de mesa.
router.get('/qr/:token', async (req, res) => {
  try {
    const m = await query('SELECT * FROM mesas WHERE qr_token = $1 AND ativa', [req.params.token]);
    // Mesma resposta para token errado e token revogado: nao ha o que diferenciar
    // para quem esta do lado de fora.
    if (!m.rows.length) {
      return res.status(404).json({ message: 'Este QR code não está mais válido. Chame o garçom.' });
    }
    res.json(await visaoDaMesa(m.rows[0]));
  } catch (e) { erro(res, e, 'Erro ao carregar a mesa'); }
});

// Caminho administrativo, por numero. Fica para o caixa e para teste; o cliente
// nao passa por aqui -- senao revogar o QR nao significaria nada.
router.get('/mesa/:numero/cardapio', async (req, res) => {
  try {
    const m = await query('SELECT * FROM mesas WHERE numero = $1 AND ativa', [Number(req.params.numero)]);
    if (!m.rows.length) return res.status(404).json({ message: 'Mesa não encontrada.' });
    res.json(await visaoDaMesa(m.rows[0]));
  } catch (e) { erro(res, e, 'Erro ao carregar o cardápio'); }
});

// -------------------------------------------------------------- comandas
// Devolve { comanda, criada }. O `criada` existe para a abertura da mesa virar
// um evento de auditoria uma vez so -- e nao a cada pedido na mesma conta.
async function comandaAberta(mesaId, cliente) {
  const exec = cliente ? (s, v) => cliente.query(s, v) : (s, v) => query(s, v);
  const achou = await exec("SELECT * FROM comandas WHERE mesa_id = $1 AND status = 'aberta'", [mesaId]);
  if (achou.rows.length) return { comanda: achou.rows[0], criada: false };
  const nova = await exec('INSERT INTO comandas (mesa_id) VALUES ($1) RETURNING *', [mesaId]);
  return { comanda: nova.rows[0], criada: true };
}

router.get('/comandas', async (req, res) => {
  const status = req.query.status || 'aberta';
  try {
    const r = await query(
      `SELECT c.*, m.numero AS mesa
         FROM comandas c JOIN mesas m ON m.id = c.mesa_id
        WHERE c.status = $1 ORDER BY c.aberta_em`,
      [status]
    );
    // Lista do caixa: cada linha precisa do total, senao a tela faz N chamadas.
    const comTotais = [];
    for (const c of r.rows) comTotais.push(Object.assign(c, { totais: await totalComanda(c.id) }));
    res.json(comTotais);
  } catch (e) { erro(res, e, 'Erro ao listar as comandas'); }
});

router.get('/comandas/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const c = await query(
      `SELECT c.*, m.numero AS mesa FROM comandas c
         JOIN mesas m ON m.id = c.mesa_id WHERE c.id = $1`,
      [id]
    );
    if (!c.rows.length) return res.status(404).json({ message: 'Comanda não encontrada.' });

    const pedidos = await query('SELECT * FROM pedidos WHERE comanda_id = $1 ORDER BY id', [id]);
    const itens = await query(
      `SELECT it.* FROM pedido_itens it JOIN pedidos p ON p.id = it.pedido_id
        WHERE p.comanda_id = $1 ORDER BY it.id`,
      [id]
    );
    const pagamentos = await query(
      'SELECT * FROM pagamentos WHERE comanda_id = $1 ORDER BY id', [id]
    );

    const comExtras = await comAdicionais(itens.rows);
    res.json({
      comanda: c.rows[0],
      pedidos: pedidos.rows.map((p) =>
        Object.assign(p, { itens: comExtras.filter((i) => i.pedido_id === p.id) })),
      pagamentos: pagamentos.rows,
      totais: await totalComanda(id),
    });
  } catch (e) { erro(res, e, 'Erro ao carregar a comanda'); }
});

router.patch('/comandas/:id', async (req, res) => {
  const { servico, desconto } = req.body || {};
  try {
    const r = await query(
      `UPDATE comandas
          SET servico  = COALESCE($2, servico),
              desconto = COALESCE($3, desconto)
        WHERE id = $1 AND status = 'aberta'
        RETURNING *`,
      [Number(req.params.id),
       servico === undefined ? null : !!servico,
       desconto === undefined ? null : dinheiro(desconto)]
    );
    if (!r.rows.length) return res.status(409).json({ message: 'Comanda não está aberta.' });
    res.json({ comanda: r.rows[0], totais: await totalComanda(r.rows[0].id) });
  } catch (e) { erro(res, e, 'Erro ao ajustar a comanda'); }
});

// Pagamento lancado no caixa, a mao. Existe SEM o modulo de pagamento: dinheiro,
// maquininha e Pix na chave da casa sao o caso normal da maioria dos bares.
router.post('/comandas/:id/pagamentos', async (req, res) => {
  const { forma, valor } = req.body || {};
  const formasCaixa = ['dinheiro', 'cartao_maquina', 'pix_chave'];
  if (!formasCaixa.includes(forma)) {
    return res.status(400).json({ message: 'Forma inválida. Use: ' + formasCaixa.join(', ') + '.' });
  }
  if (!(Number(valor) > 0)) return res.status(400).json({ message: 'Valor deve ser maior que zero.' });
  try {
    const c = await query('SELECT status FROM comandas WHERE id = $1', [Number(req.params.id)]);
    if (!c.rows.length) return res.status(404).json({ message: 'Comanda não encontrada.' });
    if (c.rows[0].status !== 'aberta') return res.status(409).json({ message: 'Comanda já fechada.' });

    const r = await query(
      `INSERT INTO pagamentos (comanda_id, forma, origem, valor) VALUES ($1, $2, 'caixa', $3)
       RETURNING *`,
      [Number(req.params.id), forma, dinheiro(valor)]
    );
    eventos.emitir('pagamento:registrado', { pagamento: r.rows[0], usuario: req.usuario || null });
    res.status(201).json({ pagamento: r.rows[0], totais: await totalComanda(Number(req.params.id)) });
  } catch (e) { erro(res, e, 'Erro ao lançar o pagamento'); }
});

router.post('/comandas/:id/fechar', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const totais = await totalComanda(id);
    if (!totais) return res.status(404).json({ message: 'Comanda não encontrada.' });
    // Centavo de tolerancia: 1/3 de R$ 283,80 nao fecha exato em divisao.
    //
    // Fechar com saldo aberto existe (cortesia, cliente que foi embora), mas
    // exige DUAS coisas: dizer explicitamente que e isso mesmo e ter perfil para
    // tanto. Garcom nao perdoa conta.
    if (totais.saldo > 0.01) {
      const insistiu = req.body && req.body.aceita_saldo_pendente;
      const podePerdoar = !req.usuario || ['admin', 'gerente', 'caixa'].includes(req.usuario.perfil);
      if (!insistiu) {
        return res.status(409).json({
          // Virgula: a mensagem vai inteira para a tela, e "R$ 8.25" num caixa
          // brasileiro faz o operador reler duas vezes.
          message: 'Ainda faltam R$ ' + totais.saldo.toFixed(2).replace('.', ',') + ' para fechar.',
          saldo_pendente: true,
          pode_perdoar: podePerdoar,
          totais,
        });
      }
      if (!podePerdoar) {
        return res.status(403).json({
          message: 'Fechar com saldo em aberto exige perfil de caixa, gerente ou admin.',
        });
      }
    }
    const aberto = await query(
      `SELECT COUNT(*)::int AS n FROM pedidos
        WHERE comanda_id = $1 AND status IN ('aguardando', 'novo', 'preparo')`,
      [id]
    );
    if (aberto.rows[0].n) {
      return res.status(409).json({ message: 'Há ' + aberto.rows[0].n + ' pedido(s) ainda na cozinha.' });
    }

    const r = await query(
      `UPDATE comandas SET status = 'fechada', fechada_em = now()
        WHERE id = $1 AND status = 'aberta' RETURNING *`,
      [id]
    );
    if (!r.rows.length) return res.status(409).json({ message: 'Comanda já estava fechada.' });

    // Chamado de fechamento pendente desta mesa morre junto: a mesa fechou, nao
    // ha mais ninguem para atender.
    await query(
      `UPDATE chamados SET status = 'resolvido', atendido_em = now()
        WHERE comanda_id = $1 AND status <> 'resolvido'`, [id]
    );

    eventos.emitir('comanda:fechada', {
      comanda: r.rows[0], totais, usuario: req.usuario || null,
    });
    res.json({ comanda: r.rows[0], totais });
  } catch (e) { erro(res, e, 'Erro ao fechar a comanda'); }
});

// --------------------------------------------------------------- pedidos
router.post('/pedidos', async (req, res) => {
  // O cliente manda `token` (o do QR); o garcom e o caixa mandam `mesa`.
  const { mesa, token, cliente, itens, pagar_agora } = req.body || {};
  if (!mesa && !token) return res.status(400).json({ message: 'Informe a mesa.' });

  // Origem: quem tem sessao e funcionario; o resto veio do QR. Nao vem do corpo
  // da requisicao de proposito -- origem que o cliente pode escolher nao serve
  // para auditar nada.
  const origem = req.usuario ? (req.usuario.perfil === 'caixa' ? 'caixa' : 'garcom') : 'qr';
  if (origem === 'garcom' && !(await cfg.ligado('operacao.garcom_lanca'))) {
    return res.status(403).json({ message: 'Lançamento de pedido pelo garçom está desligado.' });
  }
  if (!Array.isArray(itens) || !itens.length) {
    return res.status(400).json({ message: 'O pedido está vazio.' });
  }

  try {
    const modo = await cfg.ler('pagamento.modo');
    const integrado = await cfg.ligado('pagamento.integrado');

    // Quem decide se o pedido espera pagamento e ESTA linha, e so ela. O modulo
    // de pagamento nao e consultado: le-se a configuracao, nao o modulo.
    let esperaPagamento = integrado && (modo === 'antecipado' || (modo === 'ambos' && !!pagar_agora));

    // Rede de seguranca: configuracao pede "so depois de pago" mas a cobranca
    // esta desligada. Em vez de o pedido sumir, ele vai para a cozinha e a
    // resposta avisa. Nao ha cenario em que a comida deixa de ser feita.
    let aviso = null;
    if (modo === 'antecipado' && !integrado) {
      aviso = 'Pagamento antecipado configurado sem o módulo de pagamento: o pedido foi direto para a cozinha.';
      esperaPagamento = false;
    }

    const criado = await transacao(async (cx) => {
      const m = token
        ? await cx.query('SELECT * FROM mesas WHERE qr_token = $1 AND ativa', [token])
        : await cx.query('SELECT * FROM mesas WHERE numero = $1 AND ativa', [Number(mesa)]);
      if (!m.rows.length) {
        const e = new Error(token
          ? 'Este QR code não está mais válido. Chame o garçom.'
          : 'Mesa não encontrada.');
        e.status = 404; throw e;
      }

      const abertura = await comandaAberta(m.rows[0].id, cx);
      const comanda = abertura.comanda;

      const p = await cx.query(
        `INSERT INTO pedidos (comanda_id, cliente, status, liberado_em, origem, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [comanda.id, cliente || null,
         esperaPagamento ? 'aguardando' : 'novo',
         esperaPagamento ? null : new Date(),
         origem, req.usuario ? req.usuario.id : null]
      );

      const gravados = [];
      for (const item of itens) {
        const prod = await cx.query(
          'SELECT idnomeProduto, nomeProduto, precoProduto, disponivel FROM produtos WHERE idnomeProduto = $1',
          [Number(item.produto_id)]
        );
        if (!prod.rows.length) {
          const e = new Error('Produto ' + item.produto_id + ' não existe.'); e.status = 400; throw e;
        }
        if (!prod.rows[0].disponivel) {
          const e = new Error(prod.rows[0].nomeproduto + ' está indisponível.'); e.status = 409; throw e;
        }
        const qtd = Number(item.quantidade || 1);
        if (!(qtd > 0)) { const e = new Error('Quantidade inválida.'); e.status = 400; throw e; }

        // Adicionais: o preco vem do BANCO, nunca do que o celular mandou. O
        // corpo da requisicao so diz quais ids foram escolhidos.
        const escolhidos = Array.isArray(item.adicionais) ? item.adicionais.map(Number) : [];
        let extras = [];
        if (escolhidos.length) {
          const ad = await cx.query(
            `SELECT a.id, a.nome, a.preco FROM adicionais a
               JOIN produto_adicionais pa ON pa.adicional_id = a.id
              WHERE a.id = ANY($1) AND pa.produto_id = $2 AND a.ativo`,
            [escolhidos, prod.rows[0].idnomeproduto]
          );
          if (ad.rows.length !== escolhidos.length) {
            const e = new Error('Adicional inválido para esse produto.'); e.status = 400; throw e;
          }
          extras = ad.rows;
        }

        // O preco gravado no item e o UNITARIO FINAL (base + adicionais). Assim
        // todo total do sistema -- comanda, caixa, financeiro -- continua sendo
        // preco x quantidade, sem nenhuma consulta nova e sem risco de um deles
        // esquecer de somar o adicional.
        const unitario = extras.reduce((s, a) => s + Number(a.preco), Number(prod.rows[0].precoproduto));

        const i = await cx.query(
          `INSERT INTO pedido_itens (pedido_id, produto_id, nome, preco, quantidade, observacao)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [p.rows[0].id, prod.rows[0].idnomeproduto, prod.rows[0].nomeproduto,
           unitario, qtd, item.observacao || null]
        );
        for (const a of extras) {
          await cx.query(
            `INSERT INTO pedido_item_adicionais (pedido_item_id, adicional_id, nome, preco)
             VALUES ($1, $2, $3, $4)`,
            [i.rows[0].id, a.id, a.nome, a.preco]
          );
        }
        gravados.push(Object.assign(i.rows[0], { adicionais: extras }));
      }
      return { pedido: p.rows[0], itens: gravados, comanda, comandaNova: abertura.criada };
    });

    if (criado.comandaNova) eventos.emitir('comanda:aberta', { comanda: criado.comanda });
    eventos.emitir('pedido:criado', criado);
    if (!esperaPagamento) {
      eventos.emitir('pedido:liberado', Object.assign({ motivo: 'confirmado' }, criado));
    }

    res.status(201).json({
      pedido: criado.pedido,
      itens: criado.itens,
      comanda_id: criado.comanda.id,
      na_cozinha: !esperaPagamento,
      totais: await totalComanda(criado.comanda.id),
      aviso,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    erro(res, e, 'Erro ao registrar o pedido');
  }
});

// --------------------------------------------------------------- cozinha
router.get('/cozinha', async (req, res) => {
  try {
    const r = await query(
      `SELECT p.*, m.numero AS mesa,
              EXTRACT(EPOCH FROM (now() - p.liberado_em))::int AS segundos_na_fila
         FROM pedidos p
         JOIN comandas c ON c.id = p.comanda_id
         JOIN mesas m    ON m.id = c.mesa_id
        WHERE p.status IN ('novo', 'preparo', 'pronto')
        ORDER BY p.liberado_em`
    );
    const itens = await query(
      `SELECT it.* FROM pedido_itens it JOIN pedidos p ON p.id = it.pedido_id
        WHERE p.status IN ('novo', 'preparo', 'pronto') ORDER BY it.id`
    );
    const comExtras = await comAdicionais(itens.rows);
    res.json(r.rows.map((p) =>
      Object.assign(p, { itens: comExtras.filter((i) => i.pedido_id === p.id) })));
  } catch (e) { erro(res, e, 'Erro ao carregar a fila da cozinha'); }
});

// Avanco de etapa. Cada passo so sai do estado anterior: dois cozinheiros
// clicando no mesmo card nao pulam o pedido de 'novo' direto para 'entregue'.
const PASSOS = {
  preparo:  { de: ['novo'],    campo: null },
  pronto:   { de: ['preparo', 'novo'], campo: 'pronto_em' },
  entregue: { de: ['pronto'],  campo: 'entregue_em' },
};

Object.keys(PASSOS).forEach((destino) => {
  router.post('/pedidos/:id/' + destino, async (req, res) => {
    const passo = PASSOS[destino];
    try {
      const r = await query(
        `UPDATE pedidos SET status = $2` + (passo.campo ? ', ' + passo.campo + ' = now()' : '') +
        `  WHERE id = $1 AND status = ANY($3) RETURNING *`,
        [Number(req.params.id), destino, passo.de]
      );
      if (!r.rows.length) {
        return res.status(409).json({ message: 'O pedido não está em um estado que permita isso.' });
      }
      eventos.emitir('pedido:' + destino, { pedido: r.rows[0], usuario: req.usuario || null });
      res.json(r.rows[0]);
    } catch (e) { erro(res, e, 'Erro ao mudar o pedido de etapa'); }
  });
});

// Cancelar exige MOTIVO. Pedido que some sem explicacao e o buraco por onde
// passa tanto o erro honesto quanto o desvio: no fim do dia ninguem sabe se a
// comida foi feita, jogada fora ou levada embora.
router.post('/pedidos/:id/cancelar', async (req, res) => {
  const motivo = (req.body && req.body.motivo ? String(req.body.motivo) : '').trim();
  if (motivo.length < 3) {
    return res.status(400).json({ message: 'Informe o motivo do cancelamento.' });
  }
  try {
    const r = await query(
      `UPDATE pedidos SET status = 'cancelado', cancelado_em = now(), cancelado_motivo = $2
        WHERE id = $1 AND status IN ('aguardando', 'novo', 'preparo', 'pronto') RETURNING *`,
      [Number(req.params.id), motivo]
    );
    if (!r.rows.length) {
      return res.status(409).json({ message: 'Pedido já entregue ou já cancelado.' });
    }
    const itens = await query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [r.rows[0].id]);
    // O estoque escuta para devolver o que ja tinha baixado. O pedido continua
    // na comanda, marcado como cancelado -- some do total, nao do historico.
    eventos.emitir('pedido:cancelado', {
      pedido: r.rows[0], itens: itens.rows, motivo, usuario: req.usuario || null,
    });
    res.json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao cancelar o pedido'); }
});

// ------------------------------------------------- adicionais nos itens
// Uma consulta para o lote inteiro. Buscar por item daria N+1 consultas numa
// tela (cozinha, comanda) que recarrega a cada poucos segundos.
async function comAdicionais(itens) {
  if (!itens.length) return itens;
  const ids = itens.map((i) => i.id);
  const r = await query(
    'SELECT * FROM pedido_item_adicionais WHERE pedido_item_id = ANY($1) ORDER BY id', [ids]
  );
  return itens.map((i) =>
    Object.assign(i, { adicionais: r.rows.filter((a) => a.pedido_item_id === i.id) }));
}

// ----------------------------------------------------------------- salao
// A visao central do garcom e do gerente: uma linha por mesa, com o que decide
// para onde ir primeiro. Tudo em DUAS consultas -- uma por mesa seria uma
// consulta por mesa a cada 10 segundos num salao de 40 mesas.
router.get('/salao', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.id, m.numero, m.area, m.ativa, m.qr_token IS NOT NULL AS tem_qr,
              c.id AS comanda_id, c.aberta_em,
              EXTRACT(EPOCH FROM (now() - c.aberta_em))::int AS segundos_aberta,
              (SELECT COUNT(*)::int FROM pedidos p
                WHERE p.comanda_id = c.id AND p.status <> 'cancelado') AS pedidos,
              (SELECT COUNT(*)::int FROM pedidos p
                WHERE p.comanda_id = c.id AND p.status IN ('novo', 'preparo')) AS em_producao,
              (SELECT COUNT(*)::int FROM pedidos p
                WHERE p.comanda_id = c.id AND p.status = 'pronto') AS prontos,
              (SELECT COUNT(*)::int FROM pedidos p
                WHERE p.comanda_id = c.id AND p.status = 'aguardando') AS aguardando_pagamento
         FROM mesas m
         LEFT JOIN comandas c ON c.mesa_id = m.id AND c.status = 'aberta'
        ORDER BY m.area, m.numero`
    );
    const ch = await query(
      // O id precisa vir: a tela usa ele para resolver o chamado. Sem ele, o
      // botao montava /api/chamados/undefined/resolver e nao acontecia nada.
      `SELECT id, mesa_id, tipo, status, criado_em FROM chamados
        WHERE status <> 'resolvido' ORDER BY criado_em`
    );

    const mesas = [];
    for (const m of r.rows) {
      const chamados = ch.rows.filter((c) => c.mesa_id === m.id);
      // Ordem de urgencia, de cima para baixo. O que grita mais alto ganha a
      // cor da mesa: nao adianta mostrar "ocupada" quando ela chamou o garcom.
      let situacao = 'livre';
      if (chamados.some((c) => c.tipo === 'fechamento')) situacao = 'fechamento';
      else if (chamados.some((c) => c.tipo === 'atendimento')) situacao = 'atendimento';
      else if (m.prontos > 0) situacao = 'pronto';
      else if (m.em_producao > 0) situacao = 'preparo';
      else if (m.aguardando_pagamento > 0) situacao = 'aguardando_pagamento';
      else if (m.comanda_id) situacao = 'ocupada';

      mesas.push(Object.assign(m, {
        situacao,
        chamados,
        totais: m.comanda_id ? await totalComanda(m.comanda_id) : null,
      }));
    }
    res.json(mesas);
  } catch (e) { erro(res, e, 'Erro ao carregar o salão'); }
});

// -------------------------------------------------------------- chamados
// Aberto pelo cliente (pelo token do QR) e resolvido pelo salao.
router.post('/qr/:token/chamado', async (req, res) => {
  const tipo = (req.body && req.body.tipo) || 'atendimento';
  if (!['atendimento', 'fechamento'].includes(tipo)) {
    return res.status(400).json({ message: 'Tipo deve ser atendimento ou fechamento.' });
  }
  try {
    const m = await query('SELECT * FROM mesas WHERE qr_token = $1 AND ativa', [req.params.token]);
    if (!m.rows.length) return res.status(404).json({ message: 'Este QR code não está mais válido.' });

    if (tipo === 'fechamento' && !(await cfg.ligado('operacao.cliente_fecha'))) {
      return res.status(409).json({ message: 'Peça o fechamento ao garçom.' });
    }

    const c = await query(
      "SELECT id FROM comandas WHERE mesa_id = $1 AND status = 'aberta'", [m.rows[0].id]
    );

    // Chamar duas vezes nao cria dois alertas: o segundo toque so reaproveita o
    // que ja esta piscando no salao.
    const existe = await query(
      `SELECT * FROM chamados WHERE mesa_id = $1 AND tipo = $2 AND status <> 'resolvido'`,
      [m.rows[0].id, tipo]
    );
    if (existe.rows.length) {
      return res.json({ chamado: existe.rows[0], ja_existia: true });
    }

    const r = await query(
      'INSERT INTO chamados (mesa_id, comanda_id, tipo) VALUES ($1, $2, $3) RETURNING *',
      [m.rows[0].id, c.rows[0] ? c.rows[0].id : null, tipo]
    );
    eventos.emitir('chamado:aberto', { chamado: r.rows[0], mesa: m.rows[0] });
    res.status(201).json({ chamado: r.rows[0] });
  } catch (e) { erro(res, e, 'Erro ao chamar o atendimento'); }
});

router.get('/chamados', async (req, res) => {
  try {
    const r = await query(
      `SELECT ch.*, m.numero AS mesa, m.area, u.login AS usuario,
              EXTRACT(EPOCH FROM (now() - ch.criado_em))::int AS segundos
         FROM chamados ch
         JOIN mesas m ON m.id = ch.mesa_id
         LEFT JOIN usuarios u ON u.id = ch.usuario_id
        WHERE ch.status <> 'resolvido' ORDER BY ch.criado_em`
    );
    res.json(r.rows);
  } catch (e) { erro(res, e, 'Erro ao listar os chamados'); }
});

router.post('/chamados/:id/assumir', async (req, res) => {
  try {
    const r = await query(
      `UPDATE chamados SET status = 'assumido', usuario_id = $2, atendido_em = now()
        WHERE id = $1 AND status = 'aberto' RETURNING *`,
      [Number(req.params.id), req.usuario ? req.usuario.id : null]
    );
    if (!r.rows.length) return res.status(409).json({ message: 'Esse chamado já foi atendido.' });
    eventos.emitir('chamado:assumido', { chamado: r.rows[0], usuario: req.usuario || null });
    res.json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao assumir o chamado'); }
});

router.post('/chamados/:id/resolver', async (req, res) => {
  try {
    const r = await query(
      `UPDATE chamados SET status = 'resolvido', atendido_em = COALESCE(atendido_em, now())
        WHERE id = $1 AND status <> 'resolvido' RETURNING *`,
      [Number(req.params.id)]
    );
    if (!r.rows.length) return res.status(409).json({ message: 'Esse chamado já está resolvido.' });
    eventos.emitir('chamado:resolvido', { chamado: r.rows[0] });
    res.json(r.rows[0]);
  } catch (e) { erro(res, e, 'Erro ao resolver o chamado'); }
});

// ------------------------------------------------------------ historico
router.get('/comandas/:id/historico', async (req, res) => {
  try {
    res.json(await auditoria.daComanda(Number(req.params.id)));
  } catch (e) { erro(res, e, 'Erro ao carregar o histórico'); }
});

// ----------------------------------------------------- tempo real (SSE)
// Cozinha, salao e a tela do cliente deixam de depender de um botao Atualizar.
//
// O que viaja e so o NOME do evento e os ids -- quem recebe recarrega o que lhe
// interessa. Mandar o objeto inteiro significaria manter dois formatos em
// sincronia (o da rota e o do evento) e vazaria dado de uma mesa para a tela de
// outra.
const inscritos = new Set();

function difunde(evento, dados) {
  if (!inscritos.size) return;
  const pedido = dados.pedido || {};
  const chamado = dados.chamado || {};
  const corpo = JSON.stringify({
    evento,
    pedido_id: pedido.id || null,
    comanda_id: pedido.comanda_id || chamado.comanda_id || (dados.comanda && dados.comanda.id) || null,
    mesa_id: chamado.mesa_id || (dados.comanda && dados.comanda.mesa_id) || null,
    em: new Date().toISOString(),
  });
  for (const i of inscritos) {
    // Inscrito com filtro so recebe o que e da mesa dele.
    if (i.comandaId && JSON.parse(corpo).comanda_id !== i.comandaId) continue;
    try { i.res.write('data: ' + corpo + '\n\n'); } catch (e) { inscritos.delete(i); }
  }
}

['pedido:criado', 'pedido:liberado', 'pedido:preparo', 'pedido:pronto', 'pedido:entregue',
 'pedido:cancelado', 'comanda:aberta', 'comanda:fechada', 'pagamento:registrado',
 'chamado:aberto', 'chamado:assumido', 'chamado:resolvido']
  .forEach((nome) => eventos.on(nome, (dados) => difunde(nome, dados)));

function abreFluxo(req, res, comandaId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Sem isto, proxy com buffer segura os eventos e entrega tudo junto no fim.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const inscrito = { res, comandaId: comandaId || null };
  inscritos.add(inscrito);

  // Batida de 25 s: sem trafego, proxy e celular em 4G derrubam a conexao
  // ociosa por volta de 30 s e a tela congela sem avisar.
  const bate = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* o close abaixo limpa */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(bate);
    inscritos.delete(inscrito);
  });
}

router.get('/stream', (req, res) => abreFluxo(req, res, null));

router.get('/qr/:token/stream', async (req, res) => {
  try {
    const m = await query('SELECT id FROM mesas WHERE qr_token = $1 AND ativa', [req.params.token]);
    if (!m.rows.length) return res.status(404).json({ message: 'QR inválido.' });
    const c = await query(
      "SELECT id FROM comandas WHERE mesa_id = $1 AND status = 'aberta'", [m.rows[0].id]
    );
    // Sem comanda aberta ainda: escuta tudo e filtra na tela. O primeiro pedido
    // do cliente cria a comanda, e ai ele reabre o fluxo com o filtro certo.
    abreFluxo(req, res, c.rows[0] ? c.rows[0].id : null);
  } catch (e) { erro(res, e, 'Erro ao abrir o acompanhamento'); }
});

module.exports = { router, liberarPedido, totalComanda, comAdicionais };
