# Bot Discord + GitHub commits

Este bot recebe webhooks de `push` do GitHub e publica um card no canal configurado do Discord para cada commit recebido.

## Configuracao

1. Instale o Node.js 20 ou superior e execute `npm install`.
2. Copie `.env.example` para `.env` e preencha os valores:
   - `DISCORD_TOKEN`: token do bot no [Discord Developer Portal](https://discord.com/developers/applications).
   - `DISCORD_CHANNEL_ID`: ative o modo desenvolvedor no Discord, clique com o botao direito no canal e escolha **Copiar ID do canal**.
   - `GITHUB_WEBHOOK_SECRET`: texto aleatorio longo; use o mesmo no GitHub.
3. No Developer Portal, crie um bot e convide-o para o servidor com as permissoes **View Channel**, **Send Messages** e **Embed Links**.
4. Inicie localmente com `npm start`.

## Webhook no GitHub

Em **Settings → Webhooks → Add webhook** do repositorio:

- **Payload URL**: `https://SEU-DOMINIO/github/webhook`
- **Content type**: `application/json`
- **Secret**: o mesmo valor de `GITHUB_WEBHOOK_SECRET`
- **Which events?**: selecione apenas **Just the push event**.

O endpoint precisa estar publicamente acessivel por HTTPS. Para desenvolvimento local, use um tunel como Cloudflare Tunnel ou ngrok e informe a URL HTTPS gerada no GitHub.

## Execucao continua

Para producao, hospede-o em uma plataforma que aceite processos Node e exponha a porta configurada em `PORT`. Mantenha o token do Discord e o segredo do webhook somente nas variaveis de ambiente — nunca no repositorio.
