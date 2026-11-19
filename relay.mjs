import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DefaultArtifactClient } from '@actions/artifact';

const source = 'powerpower2005/stocker';
const { SOURCE_RUN_ID: runId, SESSION_ARTIFACT_ID: sessionId, SOURCE_TOKEN: sourceToken } = process.env;
const slackToken = process.env.SLACK_BOT_TOKEN;
const routes = {
  sector: process.env.SLACK_SECTOR_CHANNEL_ID,
  log: process.env.SLACK_LOG_CHANNEL_ID,
  error: process.env.SLACK_ERROR_CHANNEL_ID,
  chart: process.env.SLACK_CHART_SIGNAL_CHANNEL_ID,
};
const channels = new Set(Object.values(routes).filter(Boolean));
const channelId = /^[CG][A-Z0-9]{8,}$/;
const timestamp = /^\d+\.\d+$/;
const headline = /^\[\d{4}-\d{2}-\d{2}-[^\[\]\r\n]+\]$/;
const client = new DefaultArtifactClient();

async function retryArtifact(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === 3) throw error;
      await delay(1800 * (attempt + 1));
    }
  }
}

async function sourceApi(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch('https://api.github.com/repos/' + source + '/actions' + path, {
        headers: { Authorization: 'Bearer ' + sourceToken, 'X-GitHub-Api-Version': '2026-03-10' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return await response.json();
      if (response.status < 500 && response.status !== 429) break;
    } catch {
      // This is a read of GitHub metadata. Slack requests keep their own rules.
    }
    if (attempt < 3) await delay(1800 * (attempt + 1));
  }
  throw new Error('Source unavailable');
}

async function loadRequest(id, directory) {
  return retryArtifact(async () => {
    await client.downloadArtifact(id, {
      path: directory,
      findBy: { token: sourceToken, repositoryOwner: 'powerpower2005', repositoryName: 'stocker', workflowRunId: Number(runId) },
    });
    const path = join(directory, 'request.json');
    const value = JSON.parse(await readFile(path, 'utf8'));
    await rm(path);
    return value;
  });
}

async function slackRequest(method, payload, httpMethod = 'POST') {
  const url = new URL('https://slack.com/api/' + method);
  if (httpMethod === 'GET') url.search = new URLSearchParams(payload).toString();
  return fetch(url, {
    method: httpMethod, headers: { Authorization: 'Bearer ' + slackToken, 'Content-Type': 'application/json; charset=utf-8' },
    ...(httpMethod === 'POST' && { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(20_000),
  });
}

async function verifySlack(destinations) {
  return Array.isArray(destinations) && destinations.length === 4 &&
    destinations.every(channel => channelId.test(channel ?? '') && channels.has(channel)) && !!slackToken &&
    (await (await slackRequest('auth.test', {})).json()).ok === true;
}

function validText(value, type, limit) {
  return value?.type === type && typeof value.text === 'string' &&
    value.text.trim().length > 0 && value.text.length <= limit && Object.keys(value).length === 2;
}

function validBlock(block) {
  switch (block?.type) {
    case 'header':
      return Object.keys(block).length === 2 && validText(block.text, 'plain_text', 150);
    case 'section':
      return Object.keys(block).length === 2 && validText(block.text, 'mrkdwn', 3000);
    case 'context':
      return Object.keys(block).length === 2 && Array.isArray(block.elements) &&
        block.elements.length > 0 && block.elements.length <= 10 &&
        block.elements.every(value => validText(value, 'mrkdwn', 3000));
    case 'divider':
      return Object.keys(block).length === 1;
    default:
      return false;
  }
}

async function postSlack(payload) {
  const { destination, expected_channel, text, thread_ts, title, blocks } = payload;
  // Previously dispatched jobs may still use an approved channel ID directly.
  const channel = destination === undefined ? payload.channel
    : Object.hasOwn(routes, destination) ? routes[destination] : undefined;
  if (!slackToken || !channelId.test(channel ?? '') || !channels.has(channel)) {
    return { status: 'failed', error: 'slack_channel_or_token_not_configured' };
  }
  if (expected_channel !== undefined && expected_channel !== channel) {
    return { status: 'failed', error: 'configured_destination_changed' };
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 40_000 || (thread_ts != null && !timestamp.test(thread_ts))) {
    return { status: 'failed', error: 'invalid_message' };
  }
  if (blocks !== undefined && (destination !== 'sector' || title != null ||
      !Array.isArray(blocks) || !blocks.length || blocks.length > 50 || !blocks.every(validBlock))) {
    return { status: 'failed', error: 'invalid_blocks' };
  }
  const headlineText = blocks === undefined ? text : text.split('\n', 1)[0];
  if ((title != null && (typeof title !== 'string' || title.length > 200 || thread_ts != null || !headline.test(title))) ||
      (destination !== undefined && thread_ts == null && title == null && !headline.test(headlineText))) {
    return { status: 'failed', error: 'invalid_headline' };
  }
  const retryRateLimit = destination === undefined ? payload.retry_rate_limit === true : destination !== 'chart';
  const parent = await postMessage(channel, title ?? text, thread_ts, retryRateLimit, blocks);
  if (title == null || parent.status !== 'sent') return parent;
  await delay(1100);
  const reply = await postMessage(channel, text, parent.slack_ts, true);
  if (reply.status === 'sent') return parent;
  return { status: 'uncertain', error: reply.error, parent_ts: parent.slack_ts };
}

async function postMessage(channel, text, threadTs, retryRateLimit, blocks) {
  try {
    const message = {
      channel, text, ...(threadTs && { thread_ts: threadTs }), ...(blocks && { blocks }),
      unfurl_links: false, unfurl_media: false,
    };
    let response = await slackRequest('chat.postMessage', message);
    for (let retry = 0; response.status === 429 && retryRateLimit && retry < 2; retry++) {
      const wait = response.headers.get('retry-after');
      if (!/^\d+$/.test(wait ?? '') || Number(wait) > 60) break;
      await delay(Math.max(1, Number(wait)) * 1000);
      response = await slackRequest('chat.postMessage', message);
    }
    if (response.status === 429) return { status: 'failed', error: 'rate_limited' };
    if (!response.ok) return { status: 'uncertain', error: 'http_failure' };
    const body = await response.json();
    if (body.ok === false) return { status: 'failed', error: 'slack_rejected' };
    if (body.ok !== true || body.channel !== channel || !timestamp.test(body.ts ?? '') ||
        (threadTs && body.message?.thread_ts !== threadTs)) {
      return { status: 'uncertain', error: 'invalid_receipt' };
    }
    return { status: 'sent', slack_ts: body.ts };
  } catch {
    return { status: 'uncertain', error: 'transport_or_response_failure' };
  }
}

async function updateThreadIndex(payload) {
  const channel = routes.sector;
  const { thread_ts: threadTs, index_ts: indexTs, targets } = payload.thread_index ?? {};
  const isTimestamp = value => typeof value === 'string' && timestamp.test(value);
  if (!slackToken || payload.destination !== 'sector' || !channelId.test(channel ?? '') ||
      payload.expected_channel !== channel || !isTimestamp(threadTs) || !isTimestamp(indexTs) ||
      !Array.isArray(targets) || targets.length !== 3 || targets.some(target =>
        !isTimestamp(target?.ts) || typeof target.label !== 'string' ||
        !target.label.trim() || target.label.length > 100 || /[<>&|\r\n]/.test(target.label)) ||
      new Set([threadTs, indexTs, ...targets.map(target => target.ts)]).size !== 5) {
    return { status: 'failed', error: 'invalid_thread_index' };
  }
  try {
    const permalinks = await Promise.all([indexTs, ...targets.map(target => target.ts)].map(async ts => {
      const response = await slackRequest('chat.getPermalink', { channel, message_ts: ts }, 'GET');
      if (!response.ok) throw new Error('Slack permalink unavailable');
      const result = await response.json();
      const url = new URL(result.permalink);
      if (result.ok !== true || result.channel !== channel || url.protocol !== 'https:' ||
          !url.hostname.endsWith('.slack.com') || url.searchParams.get('thread_ts') !== threadTs) {
        throw new Error('Slack reply is outside the requested thread');
      }
      return url.href;
    }));
    const text = '*목록 바로가기*\n' +
      targets.map(({ label }, index) => `<${permalinks[index + 1]}|${label}>`).join('\n');
    const response = await slackRequest('chat.update', { channel, ts: indexTs, text });
    if (!response.ok) return { status: 'uncertain', error: 'thread_index_update_http_failure' };
    const body = await response.json();
    if (body.ok !== true || body.channel !== channel || body.ts !== indexTs) {
      return { status: 'failed', error: 'thread_index_update_rejected' };
    }
    return { status: 'sent', slack_ts: indexTs };
  } catch {
    return { status: 'uncertain', error: 'thread_index_links_unconfirmed' };
  }
}

async function handleRequest(payload) {
  if (payload.thread_index !== undefined) return updateThreadIndex(payload);
  if (payload.routes !== undefined) {
    const requested = payload.routes;
    if (!Array.isArray(requested) || !requested.length || requested.length > 4 ||
        requested.some(name => !Object.hasOwn(routes, name) || !channelId.test(routes[name] ?? ''))) {
      return { status: 'failed', error: 'relay_configuration_mismatch' };
    }
    return { status: 'routes', routes: Object.fromEntries(requested.map(name => [name, routes[name]])) };
  }
  if (payload.verify === true) {
    return await verifySlack(payload.channels ?? Object.values(routes)) ? { status: 'verified' }
      : { status: 'failed', error: 'relay_configuration_mismatch' };
  }
  return postSlack(payload);
}

async function saveReceipt(receipt, key, requestName, slot, directory) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(requestName));
  const data = Buffer.concat([cipher.update(JSON.stringify(receipt), 'utf8'), cipher.final()]);
  const file = join(directory, 'receipt.json');
  await writeFile(file, JSON.stringify({
    iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
  }));
  const name = 'receipt-' + slot;
  await retryArtifact(async attempt => {
    if (attempt) {
      try {
        // A previous upload may have committed even though its response failed.
        if (await client.getArtifact(name)) return;
      } catch {
        // The fixed artifact name makes repeating an upload attempt safe.
      }
    }
    await client.uploadArtifact(name, [file], directory, { retentionDays: 1 });
  });
}

async function serve(directory) {
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(sessionId) || process.env.GITHUB_ACTOR !== process.env.APP_ACTOR) {
    throw new Error('Unauthorized relay session');
  }
  const metadata = await sourceApi('/artifacts/' + sessionId);
  if (String(metadata.workflow_run?.id) !== runId || metadata.workflow_run?.head_branch !== 'main') {
    throw new Error('Invalid session artifact');
  }
  const session = await loadRequest(Number(sessionId), directory);
  const key = Buffer.from(session.key ?? '', 'base64');
  if (session.version !== 1 || !/^[0-9a-f-]{36}$/.test(session.id ?? '') || key.length !== 32 ||
      metadata.name !== 'slack-relay-' + session.id + '-session') {
    throw new Error('Invalid session');
  }
  for (let slot = 1; ; slot++) {
    const name = 'slack-relay-' + session.id + '-' + slot;
    const deadline = Date.now() + 100_000;
    while (true) {
      const { artifacts } = await sourceApi('/runs/' + runId + '/artifacts?name=' + name);
      const request = artifacts.find(item => item.name === name && !item.expired);
      if (request) {
        let payload;
        try {
          payload = await loadRequest(request.id, directory);
        } catch {
          await saveReceipt({ status: 'failed', error: 'relay_request_unreadable' }, key, name, slot, directory);
          break;
        }
        if (payload.close === true) return;
        await saveReceipt(await handleRequest(payload), key, name, slot, directory);
        break;
      }
      if (Date.now() >= deadline) return;
      await delay(1800);
    }
  }
}

const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'slack-relay-'));
try {
  if (!runId && !sessionId) {
    // Manual preflight verifies access without posting to any Slack channel.
    await sourceApi('/artifacts?per_page=1');
    if (!(await verifySlack(Object.values(routes)))) throw new Error('Invalid Slack configuration');
  } else {
    await serve(directory);
  }
} catch {
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
