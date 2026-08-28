# Bot Discord — commits do GitHub

Bot Discord que monitora uma branch de um repositorio GitHub e publica cards com os novos commits em um canal configurado.

Ele usa consulta periodica da API do GitHub. Portanto, nao precisa de webhook, dominio, ngrok ou servidor HTTP publico — uma boa opcao para hospedar como bot na Discloud.

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
   GITHUB_BRANCH=main
   GITHUB_TOKEN=github_pat_seu_token
   POLL_INTERVAL_SECONDS=120
   MAX_COMMITS_PER_CHECK=5
   ```

   `GITHUB_REPOSITORY` aceita `dono/repositorio` ou uma URL completa, por exemplo `https://github.com/dono/repositorio`.

   Para criar `GITHUB_TOKEN`, prefira um token fine-grained do GitHub com acesso somente ao repositorio monitorado e permissao **Contents: Read-only**. Nunca publique esse arquivo nem os tokens em um repositorio.

4. Inicie o bot:

   ```bash
   npm start
   ```

No primeiro ciclo, o bot apenas salva o commit atual como referencia e nao envia cards antigos. Os proximos commits serao publicados no intervalo configurado. O valor minimo aceito e 60 segundos; o padrao e 120 segundos.

## Eficiencia e limites

- Usa `ETag` e `If-None-Match`: quando nao existem novidades, o GitHub responde `304 Not Modified`, sem transferir a lista de commits.
- Com token GitHub, respostas condicionais `304` nao consomem o limite primario da API.
- Nunca executa consultas em paralelo, aplica timeout de 15 segundos e espera automaticamente quando a API informa limite de taxa.
- Falhas transitórias e respostas de erro usam backoff exponencial, de até 30 minutos, reduzindo consumo e ruído de logs em indisponibilidades prolongadas.
- Timeout de rede, erros do cliente Discord e desconexões de shard são registrados com contexto. Em `SIGINT` ou `SIGTERM`, o bot interrompe o agendamento e fecha a conexão Discord antes de sair.
- O SHA do ultimo card confirmado e salvo em `.commit-monitor-state.json`; reinicios no mesmo ambiente retomam a partir dele. O arquivo e ignorado pelo Git e pela Discloud para nao transportar estado antigo em um novo deploy.
- Por seguranca contra spam e rate limits, envia no maximo cinco cards por ciclo por padrao. Quando houver mais pendentes, envia primeiro os mais antigos e continua no proximo ciclo, sem descartar os demais.
- Se o SHA salvo nao estiver entre os 20 commits recebidos (por exemplo, apos force-push ou atividade intensa), o bot registra um aviso e envia apenas o commit mais recente, pois o restante nao pode ser reconstruido com seguranca.

## Hospedagem na Discloud

O projeto ja inclui:

- `discloud.config`, configurado como `TYPE=bot` com entrada `src/index.js`;
- `.discloudignore`, que exclui `node_modules`, arquivos Git e arquivos de desenvolvimento do upload.

Para enviar manualmente por ZIP, compacte a raiz do projeto contendo `package.json`, `package-lock.json`, `src`, `discloud.config` e o `.env`. O `.env` deve ser incluido nesse ZIP para o bot receber os segredos, mas nunca deve ir para o GitHub.

Se usar a integracao GitHub da Discloud, mantenha `.env` fora do repositorio e preencha as mesmas variaveis na secao **Environment Variables** do painel da Discloud.

Depois do deploy, o bot continuara verificando o repositorio sem precisar de ngrok ou de configurar Webhooks no GitHub.
