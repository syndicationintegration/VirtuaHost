// Dynamic slots that carry a saved script (one voice or a conversation): written fresh by the AI from the cast, or the saved text, then validated,
// spoken through the site's script mode and handled like every other slot (shadow, fail open, caps).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createHub } = require('../hub');
const { createStore } = require('../store');

const KEY = 'a-long-enough-control-key';
const DEN = 'America/Denver';
const audioFor = (text) => Buffer.concat([Buffer.from('ID3'), crypto.createHash('sha512').update(text).digest(), Buffer.alloc(2000, 7)]);

async function boot({ draft, filled } = {}) {
  const clock = { t: Date.parse('2026-10-22T20:00:00Z') };
  const calls = [];
  const generate = async (body, path = '/api/generate') => {
    calls.push({ path, body });
    if (path === '/api/scripts/draft') return draft ? draft(body) : { status: 200, json: { filledIn: 'Rocky: Welcome back, friends.\nBritta: Glad to be here on Green Light Radio.', copiedExample: [] } };
    if (path === '/api/scripts/filled') return filled ? filled(body) : { status: 200, json: { filledIn: 'Rocky: It is 8:04 PM.\nBritta: And you are listening to us.' } };
    if (body.mode === 'script') return { status: 200, json: { audio: audioFor(body.text).toString('base64'), lines: 2 } };
    return { status: 500, json: { error: 'unexpected call' } };
  };
  const store = createStore(null);
  const hub = createHub({ store, key: KEY, now: () => clock.t, generate, sleep: async () => {}, jitTickMs: 0, alertPollMs: 0, statusTtlMs: 0 });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const st = (await call('POST', '/stations', { name: 'Green Light Radio', connection: 'pull', broadcastTz: DEN, siteStationId: 'glr' })).json;
  await call('PUT', `/stations/${st.id}/jit`, { enabled: true });
  const slot = async (extra = {}) => (await call('POST', '/jit/slots', { stationId: st.id, kind: 'host-break', startsAt: new Date(clock.t + 8 * 60000).toISOString(), leadSeconds: 600, fallbackClipId: 'evergreen-break-1', script: { id: 'two-hosts', mode: 'draft' }, ...extra })).json;
  return { hub, call, calls, st, slot, clock, store, close: () => { hub.stop(); server.close(); server.closeAllConnections?.(); } };
}
const items = async (t) => (await t.call('GET', '/jit/items')).json.items;

test('a draft-mode script slot asks the site to write the conversation, validates the words (not the labels), and speaks it with script mode', async () => {
  const t = await boot();
  const s = await t.slot({ constraints: { prompt: 'welcome people to the show' } });
  assert.deepStrictEqual(s.script, { id: 'two-hosts', mode: 'draft' });
  await t.hub.jit.tick();
  const [item] = await items(t);
  assert.strictEqual(item.state, 'shadow');
  assert.match(item.text.filledIn, /^Rocky: Welcome back/);
  const draft = t.calls.find((c) => c.path === '/api/scripts/draft').body;
  assert.deepStrictEqual([draft.scriptId, draft.station, draft.topic, draft.at], ['two-hosts', 'glr', 'welcome people to the show', new Date(s.startsAt).toISOString()]);
  const speech = t.calls.find((c) => c.body.mode === 'script').body;
  assert.deepStrictEqual([speech.scriptId, speech.preview, speech.text], ['two-hosts', true, item.text.filledIn]);
  assert.strictEqual(item.audio.bytes > 1500, true);
  assert.strictEqual(t.store.data.jit.queue.length, 0);                                             // shadow: nothing queued
  t.close();
});

test('a fixed-text script slot uses the saved text filled in for the air time', async () => {
  const t = await boot();
  await t.slot({ script: { id: 'two-hosts', mode: 'fixed' } });
  await t.hub.jit.tick();
  const call = t.calls.find((c) => c.path === '/api/scripts/filled');
  assert.ok(call.body.at);
  assert.strictEqual((await items(t))[0].state, 'shadow');
  assert.ok(!t.calls.some((c) => c.path === '/api/scripts/draft'));
  t.close();
});

test('validation still protects a conversation: a song that was not given, or a copied example, means the planned clip plays', async () => {
  let t = await boot({ draft: () => ({ status: 200, json: { filledIn: 'Rocky: Here is "Wish You Were Here" for you.\nBritta: Lovely choice, Rocky.' } }) });
  await t.slot({ constraints: { names: [{ artist: 'Boards of Canada', title: 'Roygbiv' }] } });
  await t.hub.jit.tick();
  let [item] = await items(t);
  assert.strictEqual(item.state, 'fallback');
  assert.match(item.reason, /quotes "Wish You Were Here"/);
  assert.strictEqual(t.calls.filter((c) => c.body.mode === 'script').length, 0);                    // nothing was spoken
  assert.strictEqual(t.calls.filter((c) => c.path === '/api/scripts/draft').length, 2);              // it asked once more first
  t.close();

  t = await boot({ draft: () => ({ status: 200, json: { filledIn: 'Rocky: Same old line again, friends.\nBritta: Yes indeed it is.', copiedExample: ['Rocky'] } }) });
  await t.slot();
  await t.hub.jit.tick();
  [item] = await items(t);
  assert.strictEqual(item.state, 'fallback');
  assert.match(item.reason, /copied an example/);
  t.close();
});

test('a conversation that names a given song is allowed to', async () => {
  const t = await boot({ draft: () => ({ status: 200, json: { filledIn: 'Rocky: Next, "Roygbiv" by Boards of Canada.\nBritta: One of my favourites, Rocky.' } }) });
  await t.slot({ constraints: { names: [{ artist: 'Boards of Canada', title: 'Roygbiv' }] } });
  await t.hub.jit.tick();
  assert.strictEqual((await items(t))[0].state, 'shadow');
  t.close();
});

test('a script slot is validated when it is made', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('POST', '/jit/slots', { stationId: t.st.id, kind: 'promo', startsAt: new Date(t.clock.t + 8 * 60000).toISOString(), script: { id: 'Bad Id!' } })).status, 400);
  const ok = await t.call('POST', '/jit/slots', { stationId: t.st.id, kind: 'promo', startsAt: new Date(t.clock.t + 8 * 60000).toISOString(), script: { id: 'two-hosts', mode: 'nonsense' } });
  assert.deepStrictEqual(ok.json.script, { id: 'two-hosts', mode: 'fixed' });
  t.close();
});
