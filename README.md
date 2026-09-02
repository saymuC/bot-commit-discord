# Bot Discord — commits do GitHub

Bot Discord que monitora todas as branches de um repositorio GitHub e publica cards com os novos commits em um canal configurado.

Ele usa consulta periodica da API do GitHub. Portanto, nao precisa de webhook, dominio, ngrok ou servidor HTTP publico
## Requisitos

- Node.js 20 ou superior para desenvolvimento local.
- Um bot criado no [Discord Developer Portal](https://discord.com/developers/applications), com permissoes **View Channel**, **Send Messages** e **Embed Links** no canal escolhido.
- Um token do GitHub para repositorios privados; para repositorios publicos ele e opcional, mas recomendado.

## Configuracao

1. Instale as dependencias:

   ```bash
   npm install
   ```

2. Copie `.env.example` para `.env`.
3. Preencha as variaveis. Exemplo:

   ```env
   DISCORD_TOKEN=seu_token_do_discord
   DISCORD_CHANNEL_ID=123456789012345678
   GITHUB_REPOSITORY=seu-usuario/seu-repositorio
   GITHUB_TOKEN=github_pat_seu_token
   POLL_INTERVAL_SECONDS=60
   MAX_COMMITS_PER_CHECK=5
   DISCORD_SEND_DELAY_MS=250
   ```

   `GITHUB_REPOSITORY` aceita `dono/repositorio` ou uma URL completa, por exemplo `https://github.com/dono/repositorio`.

   Para criar `GITHUB_TOKEN`, prefira um token fine-grained do GitHub com acesso somente ao repositorio monitorado e permissao **Contents: Read-only**. Nunca publique esse arquivo nem os tokens em um repositorio.

4. Inicie o bot:

   ```bash
   npm start
   ```

No primeiro ciclo, o bot apenas salva o commit atual de cada branch como referencia e nao envia cards antigos. Os proximos commits serao publicados no intervalo configurado. O valor minimo aceito e 60 segundos;

## Eficiencia e limites

- Descobre todas as branches (inclusive quando ha mais de 100, por paginacao) e consulta os commits de cada uma; o card informa a branch de origem.
- Usa `ETag` e `If-None-Match` por branch: quando nao existem novidades, o GitHub responde `304 Not Modified`, sem transferir a lista de commits.
- Com token GitHub, respostas condicionais `304` nao consomem o limite primario da API.
- Nunca executa consultas em paralelo, aplica timeout de 15 segundos e espera automaticamente quando a API informa limite de taxa.
- Falhas transitórias e respostas de erro usam backoff exponencial, de até 30 minutos, reduzindo consumo e ruído de logs em indisponibilidades prolongadas.
- Sem `GITHUB_TOKEN`, a API pública do GitHub permite cerca de 60 consultas por hora por IP. O bot alerta ao iniciar; use token ou mantenha `POLL_INTERVAL_SECONDS` em valor compatível.
- O diretório do arquivo de estado é preparado uma vez na inicialização. Handlers globais registram rejeições e exceções não tratadas antes de encerrar o processo.
- O encerramento possui uma saída de segurança de cinco segundos: se a desconexão do Discord travar, o processo termina com código de erro em vez de permanecer pendurado.
- Timeout de rede, erros do cliente Discord e desconexões de shard são registrados com contexto. Em `SIGINT` ou `SIGTERM`, o bot interrompe o agendamento e fecha a conexão Discord antes de sair.
- O SHA do ultimo card confirmado e salvo por branch em `.commit-monitor-state.json`; reinicios no mesmo ambiente retomam a partir deles. O arquivo e ignorado pelo Git e pela Discloud para nao transportar estado antigo em um novo deploy.
- Por seguranca contra spam e rate limits, envia no maximo cinco cards por ciclo por padrao. Quando houver mais pendentes, envia primeiro os mais antigos e continua no proximo ciclo, sem descartar os demais. Entre cards, espera 250 ms por padrao; ajuste `DISCORD_SEND_DELAY_MS` entre 0 e 5000 se necessario.
- Se o SHA salvo nao estiver entre os 20 commits recebidos (por exemplo, apos force-push ou atividade intensa), o bot registra um aviso e trata toda essa janela como possivelmente nova, respeitando o limite por ciclo. Assim, os cards sao enviados gradualmente em vez de descartar commits intermediarios.
- Titulos de commits escapam Markdown antes de serem usados no embed. O bot responde a mencoes em qualquer canal ao qual tenha acesso.

Em `SIGINT` ou `SIGTERM`, o bot interrompe o agendamento e fecha a conexão Discord antes de sair. Falhas na inicialização, como ID de canal inválido ou falta de permissão, são registradas e encerram o processo com código `1`.

## Hospedagem na Discloud

O projeto ja inclui:

- `discloud.config`, configurado como `TYPE=bot` com entrada `src/index.js`;
- `.discloudignore`, que exclui `node_modules`, arquivos Git e arquivos de desenvolvimento do upload.

Para enviar manualmente por ZIP, compacte a raiz do projeto contendo `package.json`, `package-lock.json`, `src`, `discloud.config` e o `.env`. O `.env` deve ser incluido nesse ZIP para o bot receber os segredos, mas nunca deve ir para o GitHub.

Caso queira deixar automático, basta conectar o respositório ao Dicloud e usar o `.discloudignore` para evitar enviar arquivos
sensíveis, como por exemplo o `.env`, neste caso configure as variavéis de ambiente no prórpio painel da Discloud, a cada
novo commit no repositório, automaticamente a Discloud vai atualizar seu bot.
