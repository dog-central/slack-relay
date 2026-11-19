import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../relay.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .split('const directory = await mkdtemp(')[0];
const channel = 'C123456789';
const threadTs = '1795000000.000001';
const indexTs = '1795000000.000002';
const targets = ['📌 오늘 주목 3건', '🟣 신규 발굴 4건', '🟡 추적 변화 22건']
  .map((label, index) => ({ label, ts: `1795000000.00000${index + 3}` }));
const payload = { destination: 'sector', expected_channel: channel,
  thread_index: { thread_ts: threadTs, index_ts: indexTs, targets } };

function relay({ unrelated = null } = {}) {
  const updates = [];
  const context = vm.createContext({
    process: { env: { SLACK_BOT_TOKEN: 'test-token', SLACK_SECTOR_CHANNEL_ID: channel } },
    DefaultArtifactClient: class {},
    AbortSignal, URL, URLSearchParams,
    fetch: async (url, options) => {
      if (url.pathname === '/api/chat.getPermalink') {
        assert.equal(options.method, 'GET');
        assert.equal(url.searchParams.get('channel'), channel);
        const ts = url.searchParams.get('message_ts');
        const parent = ts === unrelated ? '1795000000.900000' : threadTs;
        return { ok: true, json: async () => ({ ok: true, channel,
          permalink: `https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${parent}&cid=${channel}` }) };
      }
      assert.equal(url.pathname, '/api/chat.update');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      updates.push(body);
      return { ok: true, json: async () => ({ ok: true, channel: body.channel, ts: body.ts }) };
    },
  });
  vm.runInContext(source + '\nglobalThis.handle = handleRequest;', context);
  return { handle: context.handle, updates };
}

test('updates the original first comment with verified links to each reply', async () => {
  const { handle, updates } = relay();
  const result = await handle(payload);
  assert.equal(result.status, 'sent');
  assert.equal(result.slack_ts, indexTs);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].channel, channel);
  assert.equal(updates[0].ts, indexTs);
  assert.deepEqual(updates[0].text.split('\n').slice(1), targets.map(({ label, ts }) =>
    `<https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${threadTs}&cid=${channel}|${label}>`));
});

test('does not edit a reply with cross-thread targets or a changed destination', async () => {
  const { handle, updates } = relay({ unrelated: targets[2].ts });
  assert.equal((await handle(payload)).error, 'thread_index_links_unconfirmed');
  assert.equal((await handle({ ...payload, expected_channel: 'C999999999' })).error, 'invalid_thread_index');
  assert.deepEqual(updates, []);
});
