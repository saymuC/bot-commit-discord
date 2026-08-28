import 'dotenv/config';
import { ActivityType, Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';

const requiredEnv = ['DISCORD_TOKEN', 'DISCORD_CHANNEL_ID', 'GITHUB_REPOSITORY'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Variaveis ausentes no .env: ${missing.join(', ')}`);

const repositoryReference = process.env.GITHUB_REPOSITORY
  .trim()
  .replace(/^https?:\/\/github\.com\//i, '')
  .replace(/\.git$/i, '')
  .replace(/\/$/, '');
const repositoryParts = repositoryReference.split('/');
const [owner, repository] = repositoryParts;
if (!owner || !repository || repositoryParts.length !== 2) {
  throw new Error('GITHUB_REPOSITORY deve estar no formato dono/repositorio.');
}

const pollIntervalMs = Math.max(Number(process.env.POLL_INTERVAL_SECONDS || 120), 60) * 1000;
const maxCommitsPerCheck = Math.min(Math.max(Number(process.env.MAX_COMMITS_PER_CHECK || 5), 1), 10);
const branch = process.env.GITHUB_BRANCH || 'main';
const commitsUrl = new URL(`https://api.github.com/repos/${owner}/${repository}/commits`);
commitsUrl.searchParams.set('sha', branch);
commitsUrl.searchParams.set('per_page', '20');

const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
let etag;
let lastKnownSha;

function shortSha(sha = '') {
  return sha.slice(0, 7);
}

function commitEmbed(commit) {
  const author = commit.author?.login || commit.commit.author?.name || 'Autor desconhecido';
  const avatar = commit.author?.avatar_url;
  const message = (commit.commit.message || 'Sem mensagem').split('\n')[0].slice(0, 250);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `${owner}/${repository} • novo commit` })
    .setTitle(message)
    .setURL(commit.html_url)
    .setDescription(`[${shortSha(commit.sha)}](${commit.html_url}) enviado para **${branch}**`)
    .addFields(
      { name: 'Autor', value: author, inline: true },
      { name: 'Branch', value: branch, inline: true },
      { name: 'Repositório', value: `[${repository}](https://github.com/${owner}/${repository})`, inline: true },
    )
    .setTimestamp(new Date(commit.commit.author?.date || Date.now()))
    .setFooter({ text: 'GitHub → Discord' });

  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function waitForRateLimit(response) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const resetAt = Number(response.headers.get('x-ratelimit-reset'));
  if (remaining === 0 && Number.isFinite(resetAt)) {
    return Math.max((resetAt * 1000) - Date.now(), 60_000);
  }
  return pollIntervalMs;
}

async function checkForCommits(channel) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (etag) headers['If-None-Match'] = etag;

  const response = await fetch(commitsUrl, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 304) return pollIntervalMs;
  if (!response.ok) {
    console.error(`GitHub respondeu ${response.status}: ${await response.text()}`);
    return waitForRateLimit(response);
  }

  etag = response.headers.get('etag') || etag;
  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) return pollIntervalMs;

  const newestSha = commits[0].sha;
  if (!lastKnownSha) {
    lastKnownSha = newestSha;
    console.log(`To de vigia no ${owner}/${repository} (${branch}) a partir da desgraça ${shortSha(newestSha)}.`);
    return pollIntervalMs;
  }
  if (newestSha === lastKnownSha) return pollIntervalMs;

  const previousIndex = commits.findIndex((commit) => commit.sha === lastKnownSha);
  const unseen = previousIndex === -1 ? [commits[0]] : commits.slice(0, previousIndex);
  const toSend = unseen.slice(0, maxCommitsPerCheck).reverse();

  if (unseen.length > toSend.length) {
    console.warn(`${unseen.length} commits novos detectados; enviando os ${toSend.length} mais recentes.`);
  }
  for (const commit of toSend) await channel.send({ embeds: [commitEmbed(commit)] });
  lastKnownSha = newestSha;
  return pollIntervalMs;
}

function schedulePolling(channel, delay = 0) {
  setTimeout(async () => {
    let nextDelay = pollIntervalMs;
    try {
      nextDelay = await checkForCommits(channel);
    } catch (error) {
      console.error('Deu B.O na consulta dos commits seu fdp:', error);
    }
    schedulePolling(channel, nextDelay);
  }, delay);
}

discord.once('clientReady', async () => {
  console.log(`Bot conectado como ${discord.user.tag}`);
  discord.user.setPresence({
    status: "dnd",
    activities: [
      {
        name: "To vendo as porra dos commits nessa misera",
        type: ActivityType.Custom
      }
    ]
  })
  const channel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error('DISCORD_CHANNEL_ID ta apontando pra um lugar errado seu fdp.');
  console.log(`A desgraça da consulta foi configurada para ${pollIntervalMs / 1000} segundos.`);
  schedulePolling(channel);
});

discord.login(process.env.DISCORD_TOKEN);
