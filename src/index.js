import crypto from 'node:crypto';
import 'dotenv/config';
import Fastify from 'fastify';
import { Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';

const requiredEnv = [
  'DISCORD_TOKEN',
  'DISCORD_CHANNEL_ID',
  'GITHUB_WEBHOOK_SECRET',
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Variaveis ausentes no .env: ${missing.join(', ')}`);
}

const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = Fastify({ logger: true });

// A assinatura do GitHub e calculada sobre os bytes originais da requisicao.
// Por isso mantemos o JSON como Buffer e so o decodificamos apos valida-la.
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
  done(null, body);
});

function verifyGitHubSignature(rawBody, signature) {
  if (!signature?.startsWith('sha256=')) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')}`;

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function shortSha(sha = '') {
  return sha.slice(0, 7);
}

function commitEmbed(payload, commit) {
  const repository = payload.repository;
  const author = commit.author?.username || commit.author?.name || 'Autor desconhecido';
  const avatar = commit.author?.avatar_url || repository.owner?.avatar_url;
  const branch = payload.ref?.replace('refs/heads/', '') || 'branch desconhecida';
  const message = (commit.message || 'Sem mensagem').split('\n')[0].slice(0, 250);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `${repository.full_name} • novo commit`, iconURL: repository.owner?.avatar_url })
    .setTitle(message)
    .setURL(commit.url || repository.html_url)
    .setDescription(`[${shortSha(commit.id)}](${commit.url || repository.html_url}) enviado para **${branch}**`)
    .setThumbnail(avatar)
    .addFields(
      { name: 'Autor', value: author, inline: true },
      { name: 'Branch', value: branch, inline: true },
      { name: 'Repositório', value: `[${repository.name}](${repository.html_url})`, inline: true },
    )
    .setTimestamp(new Date(commit.timestamp || Date.now()))
    .setFooter({ text: 'GitHub → Discord' });
}

app.post('/github/webhook', async (request, reply) => {
  const signature = request.headers['x-hub-signature-256'];
  const rawBody = request.body;

  if (!verifyGitHubSignature(rawBody, signature)) {
    return reply.code(401).send({ error: 'Assinatura do GitHub invalida.' });
  }

  if (request.headers['x-github-event'] !== 'push') {
    return reply.code(204).send();
  }

  const payload = JSON.parse(rawBody.toString('utf8'));
  if (payload.deleted || !payload.commits?.length) {
    return reply.code(204).send();
  }

  const channel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error('DISCORD_CHANNEL_ID nao aponta para um canal de texto acessivel.');
  }

  // O GitHub pode entregar varios commits no mesmo push; cada um recebe seu proprio card.
  for (const commit of payload.commits) {
    await channel.send({ embeds: [commitEmbed(payload, commit)] });
  }

  return reply.code(204).send();
});

discord.once('clientReady', async () => {
  console.log(`Bot conectado como ${discord.user.tag}`);
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
  console.log(`Webhook aguardando em /github/webhook na porta ${process.env.PORT || 3000}`);
});

discord.login(process.env.DISCORD_TOKEN);
