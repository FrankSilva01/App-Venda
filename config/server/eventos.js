// Barramento de eventos.
//
// O nucleo (modules/fluxo.js) anuncia o que aconteceu e NAO sabe quem escuta. E
// assim que pagamento, estoque e financeiro ficam opcionais: eles se inscrevem
// aqui. Nenhum require sai do nucleo para um modulo -- so o contrario.
//
// Todo ouvinte roda dentro de try/catch. Modulo que estoura nao pode derrubar o
// pedido que ja entrou: a casa continua vendendo com o modulo quebrado. Por isso
// tambem nada aqui devolve resultado para quem emitiu -- se o nucleo esperasse
// resposta do modulo, voltaria a depender dele.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
// Quatro modulos x alguns eventos cada passa do limite padrao (10) e o Node
// imprime um aviso de vazamento que nao e vazamento nenhum.
bus.setMaxListeners(50);

function on(evento, ouvinte) {
  bus.on(evento, (dados) => {
    // Promise.resolve envolve ouvinte sincrono e assincrono no mesmo tratamento.
    Promise.resolve()
      .then(() => ouvinte(dados))
      .catch((e) => console.error('Ouvinte de ' + evento + ' falhou (ignorado):', e.message));
  });
}

function emitir(evento, dados) {
  bus.emit(evento, dados);
}

module.exports = { on, emitir };
