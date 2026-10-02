// O "dia" dos relatórios.
//
// `new Date().toISOString().slice(0,10)` parece dia de hoje e não é: é o dia em
// UTC. No Brasil (UTC-3), das 21h à meia-noite isso já aponta para amanhã -- e
// o relatório do dia zera justamente no meio do movimento. Pior: o container
// roda em UTC, então nem o "local" do Node resolve.
//
// Por isso o fuso é explícito, e a conta de qual dia é hoje e onde o dia começa
// e termina é feita sempre a partir dele.
const FUSO = process.env.FUSO_RELATORIOS || 'America/Sao_Paulo';

// AAAA-MM-DD no fuso da casa. 'en-CA' porque é o locale que formata nessa
// ordem com zeros à esquerda -- não é por ser canadense, é por ser ISO.
function hoje() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Intervalo para a cláusula WHERE. Devolve os parâmetros na ordem em que a
// consulta os usa: início (inclusive), fim (exclusivo, = dia seguinte) e fuso.
//
// Fim exclusivo e não `BETWEEN ... 23:59:59.999`: o BETWEEN com milissegundo
// perde o que acontecer no último milissegundo do dia. Raro, mas é o tipo de
// buraco que ninguém encontra depois.
function janela(de, ate) {
  const inicio = de || hoje();
  return { inicio, fim: ate || inicio, fuso: FUSO };
}

// Trecho de SQL correspondente. `$n` é a posição do primeiro dos três
// parâmetros (início, fim, fuso).
function sqlJanela(coluna, n) {
  return `${coluna} >= ($${n}::date)::timestamp AT TIME ZONE $${n + 2}
      AND ${coluna} <  (($${n + 1}::date) + 1)::timestamp AT TIME ZONE $${n + 2}`;
}

module.exports = { FUSO, hoje, janela, sqlJanela };
