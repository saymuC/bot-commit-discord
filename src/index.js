import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
const stateFile = path.resolve(process.env.STATE_FILE || '.commit-monitor-state.json');

const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
let etag;
let lastKnownSha;
let pollingTimer;
let shuttingDown = false;
let consecutiveFailures = 0;

function resetFailureBackoff() {
  if (consecutiveFailures > 0) console.log('Conexao com GitHub restabelecida.');
  consecutiveFailures = 0;
}

function nextFailureDelay() {
  consecutiveFailures += 1;
  const delay = Math.min(pollIntervalMs * (2 ** (consecutiveFailures - 1)), 30 * 60 * 1000);
  if (consecutiveFailures === 3) {
    console.warn('Tres falhas consecutivas ao consultar o GitHub; backoff progressivo ativado.');
  }
  return delay;
}

function shortSha(sha = '') {
  return sha.slice(0, 7);
}

async function restoreState() {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.repository === repositoryReference && state.branch === branch && state.lastKnownSha) {
      lastKnownSha = state.lastKnownSha;
      console.log(`Estado restaurado: ultimo commit ${shortSha(lastKnownSha)}.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Nao foi possivel restaurar o estado do monitor:', error);
  }
}

async function persistState() {
  const temporaryFile = `${stateFile}.tmp`;
  const state = JSON.stringify({ repository: repositoryReference, branch, lastKnownSha });
  try {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(temporaryFile, state, 'utf8');
    await rename(temporaryFile, stateFile);
  } catch (error) {
    console.error('Nao foi possivel salvar o estado do monitor:', error);
  }
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

  let response;
  try {
    response = await fetch(commitsUrl, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    const wasTimeout = error.name === 'TimeoutError' || error.name === 'AbortError'
      || error.cause?.name === 'TimeoutError';
    console.error(wasTimeout ? 'Tempo limite de 15 segundos ao consultar o GitHub.' : 'Falha de rede ao consultar o GitHub:', error);
    return nextFailureDelay();
  }
  if (response.status === 304) {
    resetFailureBackoff();
    return pollIntervalMs;
  }
  if (!response.ok) {
    console.error(`GitHub respondeu ${response.status}: ${await response.text()}`);
    return Math.max(waitForRateLimit(response), nextFailureDelay());
  }

  resetFailureBackoff();
  etag = response.headers.get('etag') || etag;
  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) return pollIntervalMs;

  const newestSha = commits[0].sha;
  if (!lastKnownSha) {
    lastKnownSha = newestSha;
    await persistState();
    console.log(`Monitorando ${owner}/${repository} (${branch}) a partir de ${shortSha(newestSha)}.`);
    return pollIntervalMs;
  }
  if (newestSha === lastKnownSha) return pollIntervalMs;

  const previousIndex = commits.findIndex((commit) => commit.sha === lastKnownSha);
  if (previousIndex === -1) {
    console.warn(
      `O ultimo SHA ${shortSha(lastKnownSha)} nao esta entre os 20 commits retornados. `
      + 'O historico pode ter sido reescrito ou ser maior que a janela de consulta.',
    );
  }

  const unseen = previousIndex === -1 ? [commits[0]] : commits.slice(0, previousIndex);
  const hasMoreCommits = unseen.length > maxCommitsPerCheck;
  // A API retorna do mais novo ao mais antigo. Enviamos primeiro os mais antigos.
  const toSend = (hasMoreCommits ? unseen.slice(-maxCommitsPerCheck) : unseen).reverse();

  if (hasMoreCommits) {
    console.warn(`${unseen.length} commits novos detectados; enviando os ${toSend.length} mais antigos neste ciclo.`);
  }
  for (const commit of toSend) {
    try {
      await channel.send({ embeds: [commitEmbed(commit)] });
    } catch (error) {
      // Sem isso, o ETag atual resultaria em 304 e impediria a nova tentativa.
      etag = undefined;
      console.error(`Falha ao enviar o card do commit ${shortSha(commit.sha)}:`, error);
      throw error;
    }
    lastKnownSha = commit.sha;
    await persistState();
  }
  // Ainda existem commits pendentes; um 304 nao pode ocultar essa fila.
  if (hasMoreCommits) etag = undefined;
  return pollIntervalMs;
}

function schedulePolling(channel, delay = 0) {
  if (shuttingDown) return;
  pollingTimer = setTimeout(async () => {
    let nextDelay = pollIntervalMs;
    try {
      nextDelay = await checkForCommits(channel);
    } catch (error) {
      console.error('Falha na hora de processar os commit nessa misera:', error);
      nextDelay = nextFailureDelay();
    }
    schedulePolling(channel, nextDelay);
  }, delay);
}

discord.on('error', (error) => console.error('Erro no cliente Discord:', error));
discord.on('shardError', (error, shardId) => console.error(`Erro no shard ${shardId}:`, error));
discord.on('shardDisconnect', (event, shardId) => {
  console.warn(`Shard ${shardId} desconectado (codigo ${event.code}).`);
});

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollingTimer) clearTimeout(pollingTimer);
  console.log(`Recebi ${signal}; vou dar /kill na porra do bot.`);
  try {
    await discord.destroy();
  } catch (error) {
    console.error('DEU ERRO AO MATAR ELE CARALHOOOOO:', error);
  }
  process.exit(exitCode);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

discord.once('clientReady', async () => {
  try {
    console.log(`Bot conectado como ${discord.user.tag}`);
    discord.user.setPresence({
      status: 'dnd',
      activities: [{ name: 'To vendo as porra dos commits nessa misera', type: ActivityType.Watching }],
    });
    const channel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error('DISCORD_CHANNEL_ID nao aponta para um canal de texto acessivel.');
    await restoreState();
    console.log(`A desgraça da consulta foi configurada para ${pollIntervalMs / 1000} segundos.`);
    schedulePolling(channel);
  } catch (error) {
    console.error('Falha ao inicializar a porra do monitor de commits:', error);
    await shutdown('falha de inicializacao', 1);
  }
});

discord.login(process.env.DISCORD_TOKEN);
