# App-Venda

App de pedidos para restaurante: cardápio, carrinho, cadastro de produto e conta de usuário.

São **duas metades**, e elas moram em lugares diferentes:

| | O que é | Onde roda |
|---|---|---|
| `docs/` | as telas (HTML/CSS/JS, sem build) | **GitHub Pages** |
| `config/` | a API (Express) + PostgreSQL | **a sua máquina** |

E são **três páginas separadas**, de propósito:

| Página | Quem usa | Como chega nela |
|---|---|---|
| `docs/login.html` | funcionários | entrada do painel; sem login não há menu |
| `docs/index.html` | o restaurante | Salão, Cozinha, Caixa, Cardápio, Mesas & QR, Relatórios, Usuários, Configurações |
| `docs/mesa.html` | o cliente | **só pelo QR da mesa** — sem o token na URL, a página não abre nada |

O cliente não vê salão, cozinha, caixa nem configuração, e não escolhe a mesa: o
QR já diz qual é. O painel nem desenha o menu antes do login, e cada perfil só
enxerga as áreas que são dele.

O GitHub Pages só serve arquivo estático — não executa Node nem hospeda banco. Por
isso a tela vai para lá e a API fica local. A página tem um campo **API** no topo:
quem abrir aponta para o seu endereço e o navegador conversa direto com ele.

> O navegador bloqueia HTTP dentro de página HTTPS, **menos para `localhost`**, que é
> tratado como origem confiável. É o que faz esse arranjo funcionar sem certificado.

## Rodar a API

Precisa de Node 18+ e do PostgreSQL. O banco sobe com o `docker-compose.yml` que
está em `Lab/`:

```bash
docker compose up -d        # sobe postgres-lab na porta 5432
```

Depois, na pasta do projeto:

```bash
cp .env.example .env        # ajuste se o seu banco for outro
npm install
npm run schema              # cria/atualiza todas as tabelas (é idempotente)
npm start                   # API em http://localhost:3001
```

Para conferir: `curl http://localhost:3001/health` responde `ok` e devolve a
configuração de módulos em vigor.

Para provar que os módulos ligam e desligam sem quebrar o fluxo:

```bash
node scripts/smoke.js
```

Ele passa pelo fluxo inteiro com tudo desligado, confere que as rotas dos módulos
desligados respondem 409, liga o pagamento antecipado, liga o estoque, e no fim
devolve a configuração ao padrão e apaga o que criou.

## Primeiro acesso e perfis

Na primeira vez, com o banco sem nenhum usuário, `login.html` vira **“criar o
primeiro administrador”**. Depois disso o cadastro público fecha sozinho: quem
cria conta é o administrador, em **Usuários**.

Esqueceu a senha? Hash não se desfaz — a saída é pelo terminal, na máquina onde
a API roda:

```bash
npm run admin -- listar
npm run admin -- senha frank uma-senha-nova
npm run admin -- criar gerente uma-senha
```

Quem tem acesso ao terminal já tem acesso ao banco: isso não abre nenhuma porta
que já não estivesse aberta, e evita uma senha de recuperação escrita no código.

| Perfil | Enxerga |
|---|---|
| `admin` | tudo |
| `gerente` | salão, cozinha, caixa, cardápio, mesas, relatórios, configurações |
| `garcom` | salão (e a conta das mesas que atende) |
| `cozinha` | só a tela de produção |
| `caixa` | salão e caixa |

A sessão é uma linha na tabela `sessoes`, não um JWT assinado: **desativar um
funcionário derruba o acesso dele na hora**, e trocar a senha encerra as sessões
abertas. Com token autoassinado, quem foi desligado continuaria entrando até o
token vencer.

## Salão, garçom e chamados

**Salão** é a tela central da operação: um cartão por mesa, com a cor dada pela
situação mais urgente — chamou o garçom, pediu a conta, tem prato pronto, está
em preparo, está ocupada, está livre. Clicar na mesa abre a comanda, o histórico
e o botão **+ Adicionar pedido**.

O pedido lançado pelo garçom usa a **mesma rota** do pedido do cliente. O que
muda é que vai com sessão, e o servidor carimba `origem = garcom` e o usuário —
a origem nunca vem do corpo da requisição, senão não serviria para auditar nada.

Do celular, o cliente tem **Chamar garçom** e **Solicitar fechamento** (este
último pode ser desligado em Configurações). O painel recebe por SSE: aparece um
aviso de canto, um número no menu e a mesa muda de cor no salão.

## Tempo real

Cozinha, salão, caixa e a tela do cliente se atualizam sozinhos por **SSE**
(`GET /api/stream` e `/api/qr/:token/stream`). O evento carrega só o nome e os
ids — quem recebe recarrega o que lhe interessa. Mandar o objeto inteiro
significaria manter dois formatos em sincronia e vazaria dado de uma mesa para a
tela de outra.

O cronômetro da cozinha anda por conta própria, sem refazer a tela, e o card
muda de cor nos tempos configurados em **Configurações → Operação**.

> O painel lê o fluxo com `fetch`, não com `EventSource`: `EventSource` não
> aceita cabeçalho, e o token de sessão não pode ir na URL.

## O QR da mesa

Em **Mesas e QR**, cada mesa gera o seu. O QR carrega um **token** de 12
caracteres aleatórios, não o número da mesa — e essa escolha é o que torna
possível *excluir* um QR:

- **Gerar** cria o token e devolve o desenho em SVG, pronto para imprimir.
- **Regerar** troca o token: o adesivo que está colado na mesa **para de
  funcionar na hora**. É o que se faz quando alguém fotografou o QR.
- **Excluir** revoga sem criar outro. A mesa continua existindo e sendo atendida
  pelo caixa; quem morre é o adesivo.

Com o número da mesa na URL nada disso existiria: qualquer um pediria na mesa 7
trocando um dígito, e não haveria como cancelar um QR que vazou.

O endereço que vai dentro do QR é montado pelo servidor, a partir de duas
configurações (também em **Mesas e QR**):

| Chave | Para que serve |
|---|---|
| `cliente.url` | onde a `mesa.html` está publicada |
| `api.publica` | endereço da API **visto pelo celular do cliente** |

> No celular, `localhost` é o próprio celular. Para testar com um telefone de
> verdade, ponha o IP da sua máquina na rede (`http://192.168.0.x:3001`).

Trocar esses endereços muda os QR codes **que ainda vão ser gerados** — os já
impressos continuam apontando para o endereço antigo.

## Fluxo e módulos

O produto tem um **fluxo principal** que funciona sozinho:

```
QR da mesa → pedido → cozinha → comanda → caixa → fechamento
```

Com **todos os módulos desligados** isso funciona inteiro: o pedido vai para a
cozinha na confirmação, a conta fica aberta, e o caixa recebe dinheiro, cartão na
maquininha ou Pix na chave da casa, lançados à mão.

Três módulos são opcionais e se ligam em **Módulos** (ou `PUT /api/configuracoes`),
sem reiniciar nada:

| Módulo | Chave | Valores | O que acrescenta |
|---|---|---|---|
| Pagamento integrado | `pagamento.integrado` | `true` / `false` | Pix e cartão cobrados no app |
| Modo de pagamento | `pagamento.modo` | `fechamento` / `antecipado` / `ambos` | quando o cliente paga |
| Estoque | `estoque.modo` | `desligado` / `simples` / `ingrediente` | baixa automática e item que se esconde sozinho |
| Financeiro | `financeiro.ativo` | `true` / `false` | relatórios (só leitura) |

**O que muda a cozinha é só o gatilho**, não a tela: `pedido confirmado` no modo
padrão, `pagamento aprovado` no modo antecipado. No modo `ambos` o cliente escolhe
na comanda.

### Como o desacoplamento é feito

A dependência só aponta numa direção:

```
modules/pagamento.js  ──→  modules/fluxo.js     (chama liberarPedido)
modules/estoque.js    ──→  server/eventos.js    (escuta pedido:liberado)
modules/financeiro.js ──→  banco                (só SELECT)
modules/fluxo.js      ──→  ninguém
```

O núcleo nunca dá `require` num módulo. Ele **anuncia** (`pedido:liberado`,
`comanda:fechada`) e segue. Quem monta tudo é `config/server/Server.js`, e só ele.

Três consequências práticas:

- **Módulo que estoura não derruba pedido.** Todo ouvinte roda dentro de
  `try/catch` no barramento; o pior caso do estoque quebrado é o estoque ficar
  desatualizado, nunca a comida deixar de ser feita.
- **Rota de módulo desligado responde 409**, não 404 nem 500 — a rota existe, o
  estabelecimento é que não a habilitou.
- **Configuração incoerente é barrada na origem.** Pedir "pagamento antecipado"
  com a cobrança desligada significaria pedido que nunca chega na cozinha: o
  `PUT` recusa com 400. Se alguém editar a tabela na mão, o núcleo ainda manda o
  pedido para a cozinha e avisa na resposta.

**Disponibilidade tem uma fonte só**: a coluna `produtos.disponivel`. Com o estoque
desligado o gerente a controla na mão; com ele ligado, o módulo escreve na mesma
coluna. O cardápio nunca precisa saber quem decidiu.

## Rotas

**Núcleo** (sempre no ar):

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | API, banco e configuração de módulos |
| GET | `/produtos` | lista tudo; `?categoria=bebidas` filtra |
| POST | `/api/cadastrarProduto` | multipart, com o campo `imagemProduto` |
| PATCH | `/produtos/:id/disponibilidade` | `{disponivel}` — liga/desliga no cardápio |
| DELETE | `/produtos/:id` | remove |
| GET/POST | `/api/mesas` | lista (com a conta aberta de cada uma) e cria |
| POST | `/api/mesas/:id/qrcode` | gera **ou regera** o token; devolve a URL e o SVG |
| DELETE | `/api/mesas/:id/qrcode` | revoga: o adesivo impresso deixa de abrir |
| GET | `/api/mesas/:id/qrcode.svg` | o desenho, para imprimir |
| GET | `/api/qr/:token` | **a porta do cliente**: cardápio + conta + pedidos numa resposta |
| GET | `/api/mesa/:numero/cardapio` | o mesmo, por número — caminho administrativo |
| POST | `/api/pedidos` | `{token \| mesa, cliente, itens:[{produto_id, quantidade, observacao}], pagar_agora}` |
| GET | `/api/cozinha` | fila, com segundos desde a liberação |
| POST | `/api/pedidos/:id/preparo\|pronto\|entregue` | avança a etapa |
| POST | `/api/pedidos/:id/cancelar` | exige `{motivo}`; fica no histórico |
| GET | `/api/comandas?status=aberta` | lista do caixa, já com os totais |
| GET | `/api/comandas/:id` | pedidos, itens, pagamentos e totais |
| PATCH | `/api/comandas/:id` | `{servico, desconto}` |
| POST | `/api/comandas/:id/pagamentos` | dinheiro, maquininha ou Pix na chave |
| POST | `/api/comandas/:id/fechar` | 409 se há saldo ou pedido na cozinha |
| GET/PUT | `/api/configuracoes` | lê (aberto) e grava (perfil `config`) |
| GET | `/api/salao` | uma linha por mesa: situação, total, tempo, chamados |
| GET/POST | `/api/chamados`, `/api/chamados/:id/assumir\|resolver` | atendimento e fechamento |
| POST | `/api/qr/:token/chamado` | o cliente chama o garçom ou pede a conta |
| GET | `/api/stream`, `/api/qr/:token/stream` | SSE: painel e cliente |
| GET | `/api/comandas/:id/historico` | auditoria daquela conta |
| GET/POST/PATCH | `/api/usuarios`, `/api/usuarios/:id`, `/api/usuarios/:id/senha` | perfis |
| POST/DELETE | `/api/login`, `/api/sessao` | entrar, conferir e sair |
| GET/PUT | `/api/cardapio/categorias`, `/api/cardapio/adicionais` | cardápio administrativo |
| GET/PUT | `/api/cardapio/produtos/:id/adicionais` | o que vale para cada prato |
| POST | `/api/cadastrarUsuario` | 409 se login, e-mail ou CPF já existir |
| POST | `/api/login` | `{login, senha}` no corpo; 401 quando não confere |
| GET | `/api/usuarios` | **410** — removida, a senha ia na URL |
| GET | `/upload/<arquivo>` | serve a imagem enviada |

**Módulos** (409 quando desligados):

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/pagamento/pedido/:id` | cobra o pedido e libera a cozinha |
| POST | `/api/pagamento/comanda/:id` | paga a conta pelo celular, total ou parcial |
| GET/POST | `/api/estoque/ingredientes` | lista (marcando abaixo do mínimo) e cadastra |
| POST | `/api/estoque/ingredientes/:id/movimento` | entrada, perda ou ajuste |
| GET/PUT | `/api/estoque/ficha/:produtoId` | ficha técnica do prato |
| GET | `/api/estoque/movimentos` | últimas 50 baixas e entradas |
| GET | `/api/financeiro/resumo` | bruto, taxas, líquido, ticket médio, preparo médio |
| GET | `/api/financeiro/formas\|por-hora\|mais-vendidos\|transacoes` | recortes do dia |

> `POST /api/pagamento/*` não fala com adquirente nenhuma: `aprovar()` em
> `config/modules/pagamento.js` é um stub que aprova sempre. Trocar por Mercado
> Pago, Pagar.me ou Stripe mexe **só nessa função** — é por isso que ela está
> isolada no topo do arquivo.

## Publicar a tela no GitHub Pages

Em **Settings → Pages**, escolha *Deploy from a branch*, branch `main` e pasta
`/docs`. Em um ou dois minutos sai em
`https://franksilva01.github.io/App-Venda/`.

## O que mudou nesta revisão

- **MySQL → PostgreSQL.** Marcadores `?` viraram `$1`, `INSERT` ganhou `RETURNING`
  (o `pg` não devolve `insertId`) e as linhas agora vêm de `result.rows`.
- **Senha fora do código.** Estavam `root`/`123456` escritos em dois arquivos de um
  repositório **público**. Agora vêm do `.env`, que o `.gitignore` barra.
- **`package.json`**, que não existia — sem ele ninguém instalava as dependências.
- **`schema.sql`.** Não havia script de banco: as tabelas só existiam na máquina de
  quem escreveu. `login`, `email` e `cpf` ganharam `UNIQUE`, e o cadastro passa a
  responder 409 em vez de 500 — era um item do `Etapas.txt`.
- **Upload consertado.** O Multer gravava em `uploads/` relativo ao diretório de
  execução, e o servidor publicava `__dirname/uploads`: pastas diferentes. Rodando de
  fora da pasta do servidor, a imagem sumia; sem a pasta, estourava `ENOENT`. Agora
  as duas pontas usam o mesmo caminho absoluto, com teto de 5 MB e só imagem.
- **Filtro por categoria** em `/produtos`, outro item do `Etapas.txt`.
- **`uploads/` saiu do git.** Havia 13 MB de imagens de teste versionadas.

## Senhas

Guardadas como **hash bcrypt** (custo 10), nunca em texto. O login virou
`POST /api/login`, com a senha no corpo: na querystring ela ficava no histórico do
navegador, no `Referer` e no log de qualquer proxy no caminho. A rota antiga
responde 410 explicando, em vez de sumir calada.

Login que não existe e senha errada devolvem **a mesma mensagem** e levam **o mesmo
tempo** — quando o usuário não existe, a comparação roda contra um hash real de
descarte. Sem isso o tempo de resposta entrega quais logins existem: medido aqui,
eram 7 ms contra 60 ms antes do ajuste, e 60,5 contra 63,0 depois.

Hash não se desfaz: **esquecer a senha significa cadastrar outra**. Não há como
recuperar a original, nem pelo banco.

## O que falta

Do `Etapas.txt`, já saíram: **observação no pedido** ("sem alface", que vai
literal até a tela da cozinha), **histórico de pedidos** por comanda,
**acompanhamento do preparo** (novo → preparo → pronto → entregue) e a
**edição do pedido** antes de confirmar. Autenticação por perfil, que era o
buraco mais sério da revisão anterior, está fechada.

Seguem abertos:

- **Adquirente de verdade** no lugar do stub de pagamento.
- **Carrinho persistido** — hoje ele vive só na memória da aba.
- **HTTPS.** A sessão viaja em `Authorization` por HTTP simples na rede local.
  Em rede confiável do restaurante é aceitável; exposta à internet, não.
- **Recuperação de senha pelo próprio usuário** — hoje só o administrador
  redefine (hash não se desfaz).
- **Divisão de conta por pessoa** no caixa: hoje divide por valor, não por item.
- **Impressão em impressora térmica** (a conta sai pela janela de impressão do
  navegador).
- **Relatórios por período** além de hoje e dos recortes já existentes.
