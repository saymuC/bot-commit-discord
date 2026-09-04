import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ActivityType, Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';

const mentionWithTextList = {
  "1": "{user} eu não to entendendo porra nenhuma, mas tô aqui igual um filha da puta olhando a porra dos commit",
  "2": "vai se fuder {user} seu filha de uma puta, para me marcar randola de merda",
  "3": "seu coagulo de merda inutil, lixo humano, aborto mal sucedido, sempai {user}",
  "4": "manito hijo de puta madre, cabron safado de mierda, un real e 50 mil pesos {user}",
  "5": "Beibe beibe do biru leibe beibe, filha da puta {user}",
  "6": "u son of a bitch {user}, nigger motherfucker nigga, sybau nigger"
};

const mentioTextList = {
  "1": "{user} oq foi caralho? tem demência filha da puta? para de me marcar seu randola de merda",
  "2": "vai marcar a puta da tua mãe seu filha da puta arrombado {user}",
  "3": "{user} Ó criatura de espírito tacanho e trato enfadonho, cuja presença é tão aprazível quanto uma febre terçã em pleno estio. Poupa-me de teus impropérios, pois já me basta suportar a indigência de teu raciocínio e a assombrosa desenvoltura com que fazes alarde da própria sandice. És um néscio de rara estirpe, um biltre de compostura duvidosa, cuja prosápia excede em muito o parco cabedal de inteligência que a natureza houve por bem conceder-te. Cada palavra que profere tua boca parece fruto de longa altercação entre a ignorância e o despautério. ai, pois, importunar outra alma mais caridosa, antes que eu seja compelido a dedicar mais atenção a tão insignificante espécime de impertinência.",
  "4": `
  {user} 
Nigga, heil Hitler
Nigga, heil Hitler
Nigga, heil Hitler
All my niggas Nazis
Nigga, heil Hitler
Nigga, heil Hitler
Nigga, heil Hitler
All my niggas Nazis
Nigga, heil Hitler
Nigga, heil Hitler
Nigga, heil Hitler
Nigga, heil Hitler
Nigga, heil Hitler

  `,
  "5": "{user} Vai tomar no cu filha da puta, para de me marcar ô filha de uma puta, arrombado filha da puta"
}

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
const discordSendDelayMs = Math.min(Math.max(Number(process.env.DISCORD_SEND_DELAY_MS || 250), 0), 5_000);
const branchesUrl = new URL(`https://api.github.com/repos/${owner}/${repository}/branches`);
branchesUrl.searchParams.set('per_page', '100');
const stateFile = path.resolve(process.env.STATE_FILE || '.commit-monitor-state.json');
const stateDirectory = path.dirname(stateFile);

const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const branchEtags = new Map();
let lastKnownShas = {};
let sentCommitShas = new Set();
let branchSnapshotReady = false;
let pollingTimer;
let shuttingDown = false;
let consecutiveFailures = 0;
let stateDirectoryReady;
let shutdownTimeout;
let stateNeedsPersistence = false;

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

function mentionResponse(template, user) {
  return template
    .replaceAll('{user}', `<@${user.id}>`)
    .replaceAll('{name}', user.username);
}

function randomMentionTemplate(list) {
  const templates = Object.values(list);
  return templates[Math.floor(Math.random() * templates.length)];
}

async function prepareStateDirectory() {
  if (!stateDirectoryReady) stateDirectoryReady = mkdir(stateDirectory, { recursive: true });
  try {
    await stateDirectoryReady;
  } catch (error) {
    stateDirectoryReady = undefined;
    throw error;
  }
}

async function restoreState() {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.repository !== repositoryReference) return;

    if (state.branches && typeof state.branches === 'object') {
      lastKnownShas = Object.fromEntries(
        Object.entries(state.branches).filter(([, sha]) => typeof sha === 'string' && sha),
      );
      if (Array.isArray(state.sentCommitShas)) {
        sentCommitShas = new Set(state.sentCommitShas.filter((sha) => typeof sha === 'string' && sha));
      }
      branchSnapshotReady = state.branchSnapshotReady === true;
      console.log(`Estado restaurado para ${Object.keys(lastKnownShas).length} branch(es).`);
    } else if (state.branch && state.lastKnownSha) {
      // Migra o estado usado pelas versoes que monitoravam uma unica branch.
      lastKnownShas = { [state.branch]: state.lastKnownSha };
      console.log(`Estado restaurado para ${state.branch}: ${shortSha(state.lastKnownSha)}.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Nao foi possivel restaurar o estado do monitor:', error);
  }
}

async function persistState() {
  const temporaryFile = `${stateFile}.tmp`;
  const state = JSON.stringify({
    repository: repositoryReference,
    branchSnapshotReady,
    branches: lastKnownShas,
    sentCommitShas: [...sentCommitShas],
  });
  try {
    await writeFile(temporaryFile, state, 'utf8');
    await rename(temporaryFile, stateFile);
    stateNeedsPersistence = false;
  } catch (error) {
    stateNeedsPersistence = true;
    console.error('Nao foi possivel salvar o estado do monitor:', error);
    throw error;
  }
}

function escapeMarkdown(value) {
  return value.replace(/([\\*_~`|>\[\]()])/g, '\\$1');
}

function commitEmbed(commit, branch) {
  const author = commit.author?.login || commit.commit.author?.name || 'Autor desconhecido';
  const avatar = commit.author?.avatar_url;
  const isMerge = Array.isArray(commit.parents) && commit.parents.length > 1;
  // O limite abaixo tambem deixa margem para as barras adicionadas ao escapar Markdown.
  const message = escapeMarkdown((commit.commit.message || 'Sem mensagem').split('\n')[0]).slice(0, 250);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `${owner}/${repository} • novo commit` })
    .setTitle(message)
    .setURL(commit.html_url)
    .setDescription(isMerge
      ? `[${shortSha(commit.sha)}](${commit.html_url}) mesclado na branch **${branch}**`
      : `[${shortSha(commit.sha)}](${commit.html_url}) enviado para **${branch}**`)
    .addFields(
      { name: 'Autor', value: author, inline: true },
      { name: 'Branch', value: branch, inline: true },
      ...(isMerge ? [{ name: 'Evento', value: 'Merge entre branches', inline: true }] : []),
      { name: 'Repositório', value: `[${repository}](https://github.com/${owner}/${repository})`, inline: true },
    )
    .setTimestamp(new Date(commit.commit.author?.date || Date.now()))
    .setFooter({ text: 'GitHub → Discord' });

  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function branchCreatedEmbed(branch, sha) {
  const branchUrl = `https://github.com/${owner}/${repository}/tree/${encodeURIComponent(branch)}`;
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`Branch criada: ${branch}`)
    .setURL(branchUrl)
    .setDescription(`A branch **${escapeMarkdown(branch)}** foi detectada no repositorio.`)
    .addFields(
      { name: 'Branch', value: branch, inline: true },
      { name: 'Commit atual', value: `[${shortSha(sha)}](${branchUrl})`, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'GitHub -> Discord' });
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

function githubHeaders(etag) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (etag) headers['If-None-Match'] = etag;
  return headers;
}

async function fetchBranches() {
  const branches = [];
  let url = branchesUrl;

  while (url) {
    let response;
    try {
      response = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      const wasTimeout = error.name === 'TimeoutError' || error.name === 'AbortError'
        || error.cause?.name === 'TimeoutError';
      console.error(wasTimeout ? 'Tempo limite de 15 segundos ao listar as branches do GitHub.' : 'Falha de rede ao listar as branches do GitHub:', error);
      return { errorDelay: nextFailureDelay() };
    }
    if (!response.ok) {
      console.error(`GitHub respondeu ${response.status} ao listar as branches: ${await response.text()}`);
      return { errorDelay: Math.max(waitForRateLimit(response), nextFailureDelay()) };
    }

    const page = await response.json();
    if (!Array.isArray(page)) {
      console.error('GitHub retornou uma lista de branches em formato invalido.');
      return { errorDelay: nextFailureDelay() };
    }
    branches.push(...page.filter((item) => item?.name));
    const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? new URL(next[1]) : undefined;
  }

  resetFailureBackoff();
  return { branches };
}

async function checkBranchForCommits(channel, branch, remaining, newBranchAnchors) {
  if (remaining === 0) return { sent: 0, hasPending: true };

  const commitsUrl = new URL(`https://api.github.com/repos/${owner}/${repository}/commits`);
  commitsUrl.searchParams.set('sha', branch);
  commitsUrl.searchParams.set('per_page', '20');

  let response;
  try {
    response = await fetch(commitsUrl, {
      headers: githubHeaders(branchEtags.get(branch)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const wasTimeout = error.name === 'TimeoutError' || error.name === 'AbortError'
      || error.cause?.name === 'TimeoutError';
    console.error(wasTimeout ? `Tempo limite de 15 segundos ao consultar a branch ${branch}.` : `Falha de rede ao consultar a branch ${branch}:`, error);
    return { errorDelay: nextFailureDelay() };
  }
  if (response.status === 304) return { sent: 0 };
  if (!response.ok) {
    console.error(`GitHub respondeu ${response.status} na branch ${branch}: ${await response.text()}`);
    return { errorDelay: Math.max(waitForRateLimit(response), nextFailureDelay()) };
  }

  branchEtags.set(branch, response.headers.get('etag'));
  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) return { sent: 0 };

  const newestSha = commits[0].sha;
  const lastKnownSha = lastKnownShas[branch];
  let unseen;
  if (!lastKnownSha) {
    const anchorIndex = newBranchAnchors
      ? commits.findIndex((commit) => newBranchAnchors.has(commit.sha))
      : -1;
    if (anchorIndex === -1) {
      lastKnownShas[branch] = newestSha;
      await persistState();
      console.log(`Monitorando ${owner}/${repository} (${branch}) a partir de ${shortSha(newestSha)}.`);
      return { sent: 0 };
    }
    unseen = commits.slice(0, anchorIndex);
  } else {
    if (newestSha === lastKnownSha) return { sent: 0 };

    const previousIndex = commits.findIndex((commit) => commit.sha === lastKnownSha);
    if (previousIndex === -1) {
      console.warn(
        `O ultimo SHA ${shortSha(lastKnownSha)} da branch ${branch} nao esta entre os 20 commits retornados. `
        + 'O historico pode ter sido reescrito ou ser maior que a janela de consulta.',
      );
    }
    unseen = previousIndex === -1 ? commits : commits.slice(0, previousIndex);
  }

  if (unseen.length === 0) {
    lastKnownShas[branch] = newestSha;
    await persistState();
    return { sent: 0 };
  }

  let sent = 0;
  let processed = 0;
  const chronological = [...unseen].reverse();
  for (const commit of chronological) {
    const isMerge = Array.isArray(commit.parents) && commit.parents.length > 1;
    // Um merge representa uma acao nova na branch de destino e deve ser anunciado,
    // mesmo que o SHA tenha aparecido anteriormente em outra branch.
    const shouldSend = isMerge || !sentCommitShas.has(commit.sha);
    if (shouldSend && sent === remaining) break;

    if (shouldSend) {
      try {
        await channel.send({ embeds: [commitEmbed(commit, branch)] });
      } catch (error) {
        branchEtags.delete(branch);
        console.error(`Falha ao enviar o card do commit ${shortSha(commit.sha)} da branch ${branch}:`, error);
        throw error;
      }
      sentCommitShas.add(commit.sha);
      sent += 1;
      if (discordSendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, discordSendDelayMs));
      }
    }

    lastKnownShas[branch] = commit.sha;
    processed += 1;
    await persistState();
  }

  const hasPending = processed < chronological.length;
  if (hasPending) {
    branchEtags.delete(branch);
    console.warn(`${chronological.length - processed} commit(s) pendente(s) na branch ${branch}; continuando no proximo ciclo.`);
  }
  return { sent, hasPending };
}

async function checkForCommits(channel) {
  const branchResult = await fetchBranches();
  if (branchResult.errorDelay) return branchResult.errorDelay;

  const activeBranches = new Set(branchResult.branches.map((item) => item.name));
  let removedState = false;
  for (const branch of Object.keys(lastKnownShas)) {
    if (!activeBranches.has(branch)) {
      delete lastKnownShas[branch];
      branchEtags.delete(branch);
      removedState = true;
    }
  }
  if (removedState) await persistState();

  let remaining = maxCommitsPerCheck;
  for (const { name: branch, commit } of branchResult.branches) {
    if (branchSnapshotReady && !Object.hasOwn(lastKnownShas, branch)) {
      try {
        await channel.send({ embeds: [branchCreatedEmbed(branch, commit?.sha)] });
      } catch (error) {
        console.error(`Falha ao enviar o card da nova branch ${branch}:`, error);
        throw error;
      }
      const newBranchAnchors = new Set([
        ...Object.entries(lastKnownShas)
          .filter(([knownBranch]) => knownBranch !== branch)
          .map(([, sha]) => sha),
        ...sentCommitShas,
      ]);
      const result = await checkBranchForCommits(channel, branch, remaining, newBranchAnchors);
      if (result.errorDelay) return result.errorDelay;
      remaining -= result.sent;
      if (remaining === 0) break;
      continue;
    }
    const result = await checkBranchForCommits(channel, branch, remaining);
    if (result.errorDelay) return result.errorDelay;
    remaining -= result.sent;
    if (remaining === 0) break;
  }

  if (!branchSnapshotReady) {
    branchSnapshotReady = true;
    await persistState();
  }
  resetFailureBackoff();
  if (stateNeedsPersistence) await persistState();
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

discord.on('messageCreate', async (message) => {
  if (message.author.bot || !discord.user || !message.mentions.has(discord.user)) return;

  const mention = new RegExp(`<@!?${discord.user.id}>`, 'g');
  const textAfterMention = message.content.replace(mention, '').trim();
  const template = textAfterMention
    ? randomMentionTemplate(mentioTextList)
    : randomMentionTemplate(mentionWithTextList);

  try {
    await message.reply({
      content: mentionResponse(template, message.author),
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.error('Deu merda ao responder:', error);
  }
});

async function shutdown(signal, exitCode = 0) {
  process.exitCode = Math.max(process.exitCode || 0, exitCode);
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollingTimer) clearTimeout(pollingTimer);
  shutdownTimeout = setTimeout(() => process.exit(process.exitCode || 1), 5_000);
  shutdownTimeout.unref();
  console.log(`Recebi ${signal}; vou dar /kill na porra do bot.`);
  try {
    await discord.destroy();
  } catch (error) {
    console.error('DEU ERRO AO MATAR ELE CARALHOOOOO:', error);
  }
  clearTimeout(shutdownTimeout);
  process.exit(process.exitCode);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('Promessa rejeitada sem tratamento:', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  console.error('Excecao nao tratada:', error);
  shutdown('uncaughtException', 1);
});

discord.once('clientReady', async () => {
  try {
    console.log(`Bot conectado como ${discord.user.tag}`);
    discord.user.setPresence({
      status: 'dnd',
      activities: [{ name: 'To vendo as porra dos commits nessa misera', type: ActivityType.Custom }],
    });
    const channel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error('DISCORD_CHANNEL_ID nao aponta para um canal de texto acessivel.');
    await prepareStateDirectory();
    await restoreState();
    if (!process.env.GITHUB_TOKEN) {
      const requestsPerHour = Math.ceil(3_600_000 / pollIntervalMs);
      console.warn(
        `GITHUB_TOKEN nao definido: a API permite cerca de 60 consultas por hora sem autenticacao. `
        + `Com o intervalo atual, o bot faz ao menos ${requestsPerHour} consultas por hora e mais uma por branch monitorada.`,
      );
    }
    console.log(`A desgraça da consulta foi configurada para ${pollIntervalMs / 1000} segundos.`);
    schedulePolling(channel);
  } catch (error) {
    console.error('Falha ao inicializar a porra do monitor de commits:', error);
    await shutdown('falha de inicializacao', 1);
  }
});

discord.login(process.env.DISCORD_TOKEN);
