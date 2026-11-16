import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DefaultArtifactClient } from '@actions/artifact';

const source = 'powerpower2005/stocker';
const { SOURCE_RUN_ID: runId, SESSION_ARTIFACT_ID: sessionId, SOURCE_TOKEN: sourceToken } = process.env;
const slackToken = process.env.SLACK_BOT_TOKEN;
const channels = new Set([
  process.env.SLACK_SECTOR_CHANNEL_ID,
  process.env.SLACK_LOG_CHANNEL_ID,
  process.env.SLACK_ERROR_CHANNEL_ID,
  process.env.SLACK_CHART_SIGNAL_CHANNEL_ID,
].filter(Boolean));
const channelId = /^[CG][A-Z0-9]{8,}$/;
const timestamp = /^\d+\.\d+$/;
const client = new DefaultArtifactClient();

async function sourceApi(path) {
  const response = await fetch('https://api.github.com/repos/' + source + '/actions' + path, {
    headers: { Authorization: 'Bearer ' + sourceToken, 'X-GitHub-Api-Version': '2026-03-10' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Source unavailable');
  return response.json();
}

async function loadRequest(id, directory) {
  await client.downloadArtifact(id, {
    path: directory,
    findBy: { token: sourceToken, repositoryOwner: 'powerpower2005', repositoryName: 'stocker', workflowRunId: Number(runId) },
  });
  const path = join(directory, 'request.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  await rm(path);
  return value;
}

async function slackRequest(method, payload) {
  return fetch('https://slack.com/api/' + method, {
    method: 'POST', headers: { Authorization: 'Bearer ' + slackToken, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
  });
}

async function verifySlack(destinations) {
  return Array.isArray(destinations) && destinations.length === 4 &&
    destinations.every(channel => channelId.test(channel ?? '') && channels.has(channel)) && !!slackToken &&
    (await (await slackRequest('auth.test', {})).json()).ok === true;
}

async function postSlack(payload) {
  const { channel, text, thread_ts, reply_broadcast, retry_rate_limit } = payload;
  if (!slackToken || !channelId.test(channel ?? '') || !channels.has(channel)) {
    return { status: 'failed', error: 'slack_channel_or_token_not_configured' };
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 40_000 || (thread_ts != null && !timestamp.test(thread_ts))) {
    return { status: 'failed', error: 'invalid_message' };
  }
  try {
    const message = {
      channel, text, ...(thread_ts && { thread_ts, reply_broadcast: reply_broadcast === true }),
      unfurl_links: false, unfurl_media: false,
    };
    let response = await slackRequest('chat.postMessage', message);
    for (let retry = 0; response.status === 429 && retry_rate_limit === true && retry < 2; retry++) {
      const wait = response.headers.get('retry-after');
      if (!/^\d+$/.test(wait ?? '') || Number(wait) > 60) break;
      await delay(Math.max(1, Number(wait)) * 1000);
      response = await slackRequest('chat.postMessage', message);
    }
    if (response.status === 429) return { status: 'failed', error: 'rate_limited' };
    if (!response.ok) return { status: 'uncertain', error: 'http_failure' };
    const body = await response.json();
    if (body.ok === false) return { status: 'failed', error: 'slack_rejected' };
    if (body.ok !== true || body.channel !== channel || !timestamp.test(body.ts ?? '')) {
      return { status: 'uncertain', error: 'invalid_receipt' };
    }
    return { status: 'sent', slack_ts: body.ts };
  } catch {
    return { status: 'uncertain', error: 'transport_or_response_failure' };
  }
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
  await client.uploadArtifact('receipt-' + slot, [file], directory, { retentionDays: 1 });
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
        const payload = await loadRequest(request.id, directory);
        if (payload.close === true) return;
        const receipt = payload.verify === true
          ? (await verifySlack(payload.channels) ? { status: 'verified' } : { status: 'failed', error: 'relay_configuration_mismatch' })
          : await postSlack(payload);
        await saveReceipt(receipt, key, name, slot, directory);
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
    const destinations = ['SECTOR', 'LOG', 'ERROR', 'CHART_SIGNAL'].map(key => process.env['SLACK_' + key + '_CHANNEL_ID']);
    if (!(await verifySlack(destinations))) throw new Error('Invalid Slack configuration');
  } else {
    await serve(directory);
  }
} catch {
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
