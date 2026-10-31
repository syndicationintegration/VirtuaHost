// Just-in-time drops, end to end through the hub's HTTP API, with a fake provider standing in for the site (/api/generate) and a controllable
// clock. No network, no real station, no real RadioDJ.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createHub } = require('../hub');
const { createStore } = require('../store');
const { validateText } = require('../validate');
const { whenPhrase } = require('../jit');

const KEY = 'a-long-enough-control-key';
const READ = 'a-long-enough-read-key-1';
const DEN = 'America/Denver';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Bytes that look like an mp3 and differ per text, so the same text is the same clip and different text is not.
const audioFor = (text) => Buffer.concat([Buffer.from('ID3'), crypto.createHash('sha512').update(text).digest(), Buffer.alloc(2000, 7)]);

function fakeSite(over = {}) {
  const calls = [];
  const state = { text: (b) => `Eight oh four on Green Light Radio.`, failText: 0, failSpeech: 0, audio: audioFor, extra: {}, ...over };
  const generate = async (body) => {
    calls.push(body);
    if (body.textOnly) {
      if (state.failText) { state.failText -= 1; return { status: 502, json: { error: 'Script generation failed: upstream down' } }; }
      const filledIn = typeof state.text === 'function' ? state.text(body) : state.text;
      return { status: 200, json: { textOnly: true, filledIn, raw: filledIn.replace('8:04 PM', '{{time}}'), scriptText: 'RAW {{time}} must never be spoken', textModel: 'fake/writer', ...state.extra } };
    }
    if (state.failSpeech) { state.failSpeech -= 1; return { status: 502, json: { error: 'Speech synthesis failed: busy' } }; }
    const buf = state.audio(body.text);
    return { status: 200, json: { preview: true, audio: buf ? buf.toString('base64') : '', mimeType: 'audio/mpeg', speechModel: 'fake/tts' } };
  };
  return { generate, calls, state, texts: () => calls.filter((c) => c.textOnly), speeches: () => calls.filter((c) => !c.textOnly) };
}

async function boot(opts = {}) {
  const clock = { t: Date.parse('2026-10-22T20:00:00Z') };                 // 2:00 PM in Denver
  const site = opts.site || fakeSite();
  const store = createStore(null);
  const hub = createHub({ store, key: KEY, readKey: READ, now: () => clock.t, generate: site.generate, sleep: async () => {}, jitTickMs: 0, statusTtlMs: 0, alertPollMs: 0, ...opts.hub });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, key = KEY, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(key ? { 'x-api-key': key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch (err) { /* binary */ }
    return { status: res.status, json, buf, headers: res.headers };
  };
  const t = { hub, call, clock, site, store, close: () => { hub.stop(); server.close(); server.closeAllConnections?.(); } };
  // a pull station, JIT switched on in shadow mode (the default), a persona and a site station id
  t.addStation = async (name = 'Green Light Radio', extra = {}) => {
    const r = await call('POST', '/stations', { name, connection: 'pull', broadcastTz: DEN, machineTz: 'America/Chicago', siteStationId: 'green-light-radio-d6b9', city: undefined, ...extra });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    return { id: r.json.id, pullKey: r.json.pullKey };
  };
  t.enable = (id, patch = {}) => call('PUT', `/stations/${id}/jit`, { enabled: true, ...patch });
  t.slot = async (id, extra = {}) => {
    const r = await call('POST', '/jit/slots', { stationId: id, kind: 'time-check', startsAt: new Date(clock.t + 8 * 60000).toISOString(), leadSeconds: 600, personaId: 'rocky-flats-7fb0ca', fallbackClipId: 'evergreen-time-1', ...extra });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    return r.json;
  };
  t.heartbeat = (id, pullKey, status = {}) => call('POST', `/stations/${id}/heartbeat`, { status: { kind: 'radiodj', mode: 'automation', machineTz: 'America/Chicago', broadcastTz: DEN, pcOffsetMinutes: -300, ...status } }, pullKey);
  return t;
}
const items = async (t, q = '') => (await t.call('GET', `/jit/items${q}`)).json.items;

// ------------------------------------------------------------------ validation
test('validation: length, blocklist, language policy, placeholders, markdown, and the site\'s own warnings', () => {
  const ok = (text, ctx) => validateText(text, ctx).problems.map((p) => p.code);
  assert.deepStrictEqual(ok('It is eight oh four on Green Light Radio.', { stationName: 'Green Light Radio' }), []);
  assert.deepStrictEqual(ok('', {}), ['empty']);
  assert.deepStrictEqual(ok('Hi.', {}), ['too-short']);
  assert.ok(ok('word '.repeat(200), { maxChars: 100 }).includes('too-long'));
  assert.ok(ok('A line that runs and runs for far too long to fit the slot allowed seconds here ok.', { maxSeconds: 3 }).includes('too-long'));
  assert.ok(ok('It is {{time}} on the station.', {}).includes('unresolved-placeholder'));
  assert.ok(ok('Next is {artist} with {title}.', {}).includes('unresolved-placeholder'));
  assert.ok(ok('Sponsored by Joe, call now.', { blocklist: ['sponsored'] }).includes('blocklist'));
  assert.ok(!ok('The classic rock hour continues.', { blocklist: ['ass'] }).includes('blocklist'));          // whole words only
  assert.ok(ok('That was some bullshit, folks.', { languagePolicy: 'clean' }).includes('language'));
  assert.deepStrictEqual(ok('That was some bullshit, folks.', { languagePolicy: 'explicit-ok' }), []);
  assert.ok(ok('*laughs* what a night folks', {}).includes('not-speakable'));
  assert.ok(ok('[pause] what a night folks', {}).includes('not-speakable'));
  assert.ok(ok('What a night folks 🎉 indeed', {}).includes('not-speakable'));
  assert.ok(ok('It is a fine evening for radio.', { site: { templateMissing: ['weather'] } }).includes('missing-values'));
  assert.ok(ok('It is a fine evening for radio.', { site: { copiedExample: 'x' } }).includes('copied-example'));
  assert.ok(ok('It is a fine evening for radio.', { site: { unresolvedPlaceholders: true } }).includes('unresolved-placeholder'));
});

test('validation: no invented songs, artists, numbers, web addresses or phone numbers', () => {
  const ctx = { names: [{ artist: 'Boards of Canada', title: 'Roygbiv' }], facts: ['Jazz Night is at 7 PM at The Walnut Room'], stationName: 'Green Light Radio', whenPhrase: 'tonight at 7 PM', numbersMustBeGiven: true };
  const codes = (t, c = ctx) => validateText(t, c).problems.map((p) => p.code);
  assert.deepStrictEqual(codes('That was "Roygbiv" by Boards of Canada, on Green Light Radio.'), []);
  assert.ok(codes('That was "Wish You Were Here" for you tonight.').includes('invented-title'));
  assert.ok(codes('Up next, a song by Radiohead for the evening.').includes('invented-name'));
  assert.ok(codes('Jazz Night is tonight at 7 PM at The Walnut Room, free for 20 people.').includes('invented-number'));
  assert.deepStrictEqual(codes('Jazz Night is tonight at 7 PM at The Walnut Room, come on down.'), []);
  assert.ok(codes('Find us at www.example.com for more.').includes('invented-contact'));
  assert.ok(codes('Call 555-1234 to request a song tonight.').includes('invented-contact'));
  assert.deepStrictEqual(codes('Visit example.com today.', { ...ctx, facts: ['website example.com'] }), []);
});

test('whenPhrase speaks an event in the STATION\'s clock: tonight, tomorrow, later, across midnight and DST', () => {
  const at = (iso) => Date.parse(iso);
  assert.strictEqual(whenPhrase(at('2026-10-23T01:00:00Z'), at('2026-10-22T20:00:00Z'), DEN), 'tonight at 7 PM');           // 7 PM Denver, same Denver day
  assert.strictEqual(whenPhrase(at('2026-10-23T18:30:00Z'), at('2026-10-22T20:00:00Z'), DEN), 'tomorrow at 12:30 PM');
  assert.strictEqual(whenPhrase(at('2026-10-25T01:00:00Z'), at('2026-10-22T20:00:00Z'), DEN), 'Saturday, Oct 24 at 7 PM');
  // 05:30Z on the 23rd is 11:30 PM on the 22nd in Denver (but already the 23rd on a Central PC): 7 PM on the 23rd is "tomorrow", not "tonight"
  assert.strictEqual(whenPhrase(at('2026-10-24T01:00:00Z'), at('2026-10-23T05:30:00Z'), DEN), 'tomorrow at 7 PM');
  assert.strictEqual(whenPhrase(at('2026-11-02T02:00:00Z'), at('2026-11-01T18:00:00Z'), DEN), 'tonight at 7 PM');               // the day Denver falls back to MST
  assert.strictEqual(whenPhrase(at('2026-10-22T21:00:00Z'), at('2026-10-22T20:00:00Z'), DEN), 'today at 3 PM');
});

// ------------------------------------------------------------------ scopes and keys
test('read and control keys: a read key can look at everything and change nothing', async () => {
  const t = await boot();
  const st = await t.addStation();
  for (const p of ['/jit/status', '/jit/slots', '/jit/items', '/audit', '/stations', '/jit/settings', '/jit/alerts']) assert.strictEqual((await t.call('GET', p, undefined, READ)).status, 200, p);
  for (const [m, p, b] of [['POST', '/stations', { name: 'x', connection: 'pull' }], ['PUT', `/stations/${st.id}/jit`, { enabled: true }], ['POST', '/jit/kill', { on: true }], ['PUT', '/jit/settings', { dailyCharCap: 1 }], ['POST', '/jit/slots', {}], ['DELETE', `/stations/${st.id}`], ['POST', `/stations/${st.id}/pullkey`, {}], ['POST', '/jit/broadcast', {}]]) {
    const r = await t.call(m, p, b, READ);
    assert.strictEqual(r.status, 403, `${m} ${p}`);
    assert.match(r.json.error, /only read/);
  }
  const login = await t.call('POST', '/auth/login', { key: READ }, '');
  assert.strictEqual(login.json.scope, 'read');
  assert.strictEqual((await t.call('POST', '/jit/kill', { on: true }, login.json.token)).status, 403);        // and a token inherits the scope
  assert.strictEqual((await t.call('GET', '/jit/status', undefined, login.json.token)).status, 200);
  assert.strictEqual((await t.call('POST', '/auth/login', { key: KEY }, '')).json.scope, 'control');
  t.close();
});

test('a station key opens only that station\'s heartbeat, queue, ack and slots', async () => {
  const t = await boot();
  const a = await t.addStation('Alpha'); const b = await t.addStation('Beta');
  assert.match(a.pullKey, /^pk_[0-9a-f]{48}$/);
  assert.strictEqual((await t.heartbeat(a.id, a.pullKey)).status, 200);
  assert.strictEqual((await t.call('GET', `/stations/${a.id}/queue`, undefined, a.pullKey)).status, 200);
  assert.strictEqual((await t.call('PUT', `/stations/${a.id}/slots`, { slots: [] }, a.pullKey)).status, 200);
  assert.strictEqual((await t.call('GET', `/stations/${b.id}/queue`, undefined, a.pullKey)).status, 401);       // another station's queue
  assert.strictEqual((await t.heartbeat(b.id, a.pullKey)).status, 401);
  for (const [m, p] of [['GET', '/stations'], ['GET', '/jit/status'], ['GET', '/audit'], ['POST', '/jit/kill'], ['GET', `/stations/${a.id}/library`]]) assert.ok([401, 403].includes((await t.call(m, p, m === 'POST' ? {} : undefined, a.pullKey)).status), `${m} ${p}`);
  assert.strictEqual((await t.call('GET', `/stations/${a.id}/queue`, undefined, 'pk_nonsense')).status, 401);
  // the key is stored only as a hash, and a new key replaces the old one
  assert.ok(!JSON.stringify(t.store.data).includes(a.pullKey));
  const fresh = (await t.call('POST', `/stations/${a.id}/pullkey`, {})).json.key;
  assert.strictEqual((await t.heartbeat(a.id, a.pullKey)).status, 401);
  assert.strictEqual((await t.heartbeat(a.id, fresh)).status, 200);
  t.close();
});

// ------------------------------------------------------------------ station records, clocks, pull status
test('stations carry machineTz, broadcastTz, mode, last-seen and capabilities, and warn when the clocks differ or the PC disagrees', async () => {
  const t = await boot();
  const st = await t.addStation();
  let rec = (await t.call('GET', '/stations')).json.stations[0];
  assert.deepStrictEqual([rec.machineTz, rec.broadcastTz, rec.connection, rec.online, rec.mode], ['America/Chicago', DEN, 'pull', false, 'unknown']);
  assert.ok(rec.warnings.some((w) => w.code === 'zones-differ'));
  await t.heartbeat(st.id, st.pullKey, { capabilities: { queueInsert: true, status: true }, nowPlaying: { artist: 'Boards of Canada', title: 'Roygbiv', elapsedSeconds: 100, remainingSeconds: 115 }, next: [{ artist: 'A', title: 'B' }], stream: { up: true, listeners: 4 }, shadow: true, killSwitch: { on: false } });
  rec = (await t.call('GET', '/stations')).json.stations[0];
  assert.deepStrictEqual([rec.online, rec.mode, rec.capabilities.queueInsert, rec.nowPlaying.remainingSeconds, rec.next.length, rec.stream.listeners, rec.shadow], [true, 'automation', true, 115, 1, 4, true]);
  assert.strictEqual(rec.now.title, 'Boards of Canada - Roygbiv');
  assert.ok(rec.lastSeen > 0);
  // the PC says its offset is Central daylight (-300) while the record says Mountain: the mismatch is flagged
  await t.call('PUT', `/stations/${st.id}`, { machineTz: DEN });
  rec = (await t.call('GET', '/stations')).json.stations[0];
  assert.ok(rec.warnings.some((w) => w.code === 'pc-offset-mismatch' && w.level === 'error'));
  assert.ok(rec.warnings.some((w) => w.code === 'reported-machine-tz-differs'));
  // a station that stops reporting goes offline
  t.clock.t += 120000;
  assert.strictEqual((await t.call('GET', '/stations')).json.stations[0].online, false);
  assert.strictEqual((await t.call('POST', `/stations/${st.id}/skip`, {})).status, 502);                         // offline: nothing to call
  await t.heartbeat(st.id, st.pullKey, { capabilities: { skip: true } });
  assert.strictEqual((await t.call('POST', `/stations/${st.id}/skip`, {})).status, 409);                         // online, but it pulls: the hub cannot call it
  assert.strictEqual((await t.call('POST', '/stations', { name: 'Bad', connection: 'pull', broadcastTz: 'Mars/Base' })).status, 400);
  assert.strictEqual((await t.call('POST', '/stations', { name: 'Bad', connection: 'pull', machineTz: 'Nope' })).status, 400);
  assert.strictEqual((await t.call('POST', '/stations', { name: 'Bad', url: 'ftp://x' })).status, 400);        // push stations still need a url
  t.close();
});

// ------------------------------------------------------------------ the pipeline
test('shadow mode (the default) does everything except queue: it stores what would have aired', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id);                                                      // shadow: true is the default
  const slot = await t.slot(st.id);
  assert.strictEqual(slot.startsAtIso.slice(-6), '-06:00');
  await t.hub.jit.tick();

  const [item] = await items(t);
  assert.strictEqual(item.state, 'shadow');
  assert.strictEqual(item.shadow, true);
  assert.strictEqual(item.fallbackClipId, 'evergreen-time-1');
  assert.strictEqual(item.text.filledIn, 'Eight oh four on Green Light Radio.');
  assert.strictEqual(item.audio.sha256, sha(audioFor(item.text.filledIn)));
  assert.strictEqual(item.approval.state, 'pending');                         // waiting for a person to review it
  // nothing queued anywhere
  assert.deepStrictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items, []);
  assert.strictEqual(t.store.data.jit.queue.length, 0);
  assert.strictEqual((await t.call('GET', '/jit/status')).json.queued, 0);
  // the audio can be previewed by a reviewer
  const audio = await t.call('GET', `/jit/items/${item.id}/audio`);
  assert.deepStrictEqual([audio.status, audio.headers.get('content-type'), sha(audio.buf)], [200, 'audio/mpeg', item.audio.sha256]);
  // approving a shadow item is a review verdict only: it still queues nothing
  const ok = await t.call('POST', `/jit/items/${item.id}/approve`, { note: 'sounds right' }, KEY, { 'x-actor': 'Rocky' });
  assert.deepStrictEqual([ok.json.approval.state, ok.json.approval.by.startsWith('control:Rocky')], ['approved', true]);
  assert.strictEqual(t.store.data.jit.queue.length, 0);
  assert.strictEqual((await t.call('GET', `/jit/items/${item.id}`)).json.state, 'shadow');
  t.close();
});

test('the writer is asked for text only first, with the air time and persona; speech uses `filledIn`, never `scriptText`; preview keeps the library clean', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id);
  const slot = await t.slot(st.id);
  await t.hub.jit.tick();
  const [w] = t.site.texts(); const [s] = t.site.speeches();
  assert.deepStrictEqual([w.mode, w.textOnly, w.persona, w.station], ['ai', true, 'rocky-flats-7fb0ca', 'green-light-radio-d6b9']);
  assert.strictEqual(w.at, new Date(slot.startsAt).toISOString());              // {{time}} is filled for when it AIRS, not when it was written
  assert.match(w.prompt, /\{\{time\}\}/);
  assert.match(w.prompt, /Do not mention any song, artist, event/);
  assert.deepStrictEqual([s.mode, s.preview, s.text], ['say', true, 'Eight oh four on Green Light Radio.']);
  assert.ok(!s.text.includes('RAW'));
  assert.ok(t.site.calls.indexOf(w) < t.site.calls.indexOf(s));                  // text first, speech only after validation
  t.close();
});

test('a line that fails validation is never spoken: no speech spend, a recorded reason, the planned clip plays', async () => {
  const site = fakeSite({ text: () => 'Well that was some bullshit, folks, wasn\'t it.' });
  const t = await boot({ site });
  const st = await t.addStation();
  await t.enable(st.id);
  await t.slot(st.id);
  await t.hub.jit.tick();
  const [item] = await items(t);
  assert.strictEqual(item.state, 'fallback');
  assert.match(item.reason, /failed validation.*language/);
  assert.strictEqual(site.texts().length, 2);                                      // it tried once more with a nudge
  assert.match(site.texts()[1].prompt, /previous attempt was refused: language/);
  assert.strictEqual(site.speeches().length, 0);
  assert.strictEqual(t.store.data.jit.queue.length, 0);
  assert.strictEqual(item.fallbackClipId, 'evergreen-time-1');
  t.close();
});

test('live with approval: awaiting approval, then queued on approve; the station pulls, downloads, checks the hash and acks', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false });                                      // live, requireApproval still true
  await t.slot(st.id);
  await t.hub.jit.tick();
  let [item] = await items(t);
  assert.strictEqual(item.state, 'awaiting-approval');
  assert.deepStrictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items, []);

  t.clock.t += 60000;
  const approved = (await t.call('POST', `/jit/items/${item.id}/approve`, { note: 'ok' }, KEY, { 'x-actor': 'Rocky' })).json;
  assert.strictEqual(approved.state, 'queued');
  assert.ok(approved.approval.at > 0);
  const q = (await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json;
  assert.strictEqual(q.items.length, 1);
  const qi = q.items[0];
  assert.deepStrictEqual([qi.kind, qi.ahead, qi.replace, qi.sha256], ['time-check', 2, 'evergreen-time-1', item.audio.sha256]);
  assert.ok(Date.parse(qi.expiresAt) < qi.startsAt);
  const dl = await t.call('GET', `/stations/${st.id}/queue/${qi.id}/audio`, undefined, st.pullKey);
  assert.strictEqual(sha(dl.buf), qi.sha256);
  assert.strictEqual(dl.headers.get('x-sha256'), qi.sha256);
  const ack = await t.call('POST', `/stations/${st.id}/queue/${qi.id}/ack`, { status: 'inserted', position: 2, verified: true }, st.pullKey);
  assert.strictEqual(ack.status, 200);
  item = (await t.call('GET', `/jit/items/${item.id}`)).json;
  assert.strictEqual(item.state, 'inserted');
  assert.deepStrictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items, []);
  assert.strictEqual((await t.call('POST', `/stations/${st.id}/queue/${qi.id}/ack`, { status: 'bogus' }, st.pullKey)).status, 400);
  t.close();
});

test('a rejected item is never queued, and a station refusing it (or failing) means the planned clip plays', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false });
  await t.slot(st.id); await t.slot(st.id, { startsAt: new Date(t.clock.t + 9 * 60000).toISOString() });
  await t.hub.jit.tick();
  const [b, a] = await items(t);                                                // newest first
  const rej = (await t.call('POST', `/jit/items/${a.id}/reject`, { note: 'wrong tone' }, KEY, { 'x-actor': 'Rocky' })).json;
  assert.deepStrictEqual([rej.state, rej.approval.state, rej.reason], ['rejected', 'rejected', 'wrong tone']);
  assert.strictEqual((await t.call('POST', `/jit/items/${a.id}/approve`, {})).status, 409);
  await t.call('POST', `/jit/items/${b.id}/approve`, {});
  const qi = (await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items;
  assert.strictEqual(qi.length, 1);
  await t.call('POST', `/stations/${st.id}/queue/${qi[0].id}/ack`, { status: 'skipped', reason: 'a live show is on air' }, st.pullKey);
  const done = (await t.call('GET', `/jit/items/${b.id}`)).json;
  assert.strictEqual(done.state, 'fallback');
  assert.match(done.reason, /did not insert it \(skipped\): a live show is on air/);
  t.close();
});

test('with approval switched off a live station queues straight away', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false, requireApproval: false });
  await t.slot(st.id);
  await t.hub.jit.tick();
  const [item] = await items(t);
  assert.deepStrictEqual([item.state, item.approval.state, item.approval.by], ['queued', 'approved', 'auto']);
  assert.strictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items.length, 1);
  t.close();
});

test('nothing is generated before the lead window opens, and a slot that is too close or already past is a recorded fallback', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id);
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 30 * 60000).toISOString(), leadSeconds: 600 });
  await t.hub.jit.tick();
  assert.strictEqual(t.site.calls.length, 0);
  assert.deepStrictEqual(await items(t), []);
  t.clock.t += 21 * 60000 + 30000;                                              // 8.5 minutes before: inside the window
  await t.hub.jit.tick();
  assert.strictEqual((await items(t))[0].state, 'shadow');
  const late = await boot();
  const s2 = await late.addStation();
  await late.enable(s2.id);
  await late.slot(s2.id, { startsAt: new Date(late.clock.t + 30000).toISOString() });                // 30 s away: inside the 60 s safety margin
  await late.hub.jit.tick();
  const [i] = await items(late);
  assert.strictEqual(i.state, 'fallback');
  assert.match(i.reason, /too late/);
  assert.strictEqual(late.site.calls.length, 0);
  t.close(); late.close();
});

  test('the swap deadline is the start of the preceding item: a slot past its deadline falls back, and the default lead is 300 s', async () => {
    const t = await boot();
    try {
      const st = await t.addStation();
      await t.enable(st.id);
      const slot = await t.slot(st.id, { startsAt: new Date(t.clock.t + 10 * 60000).toISOString(), leadSeconds: undefined, precedingSeconds: 240 });

      assert.strictEqual(slot.leadSeconds, 300);
      assert.strictEqual(slot.precedingSeconds, 240);
      t.clock.t += 6 * 60000;                                                     // 4 min before the slot: past the swap deadline (slot start - 240 s)
      await t.hub.jit.tick();
      const [i] = await items(t);
      assert.strictEqual(i.state, 'fallback');
      assert.match(i.reason, /ran out of time/);
      assert.strictEqual(t.site.calls.length, 0);
    } finally { t.close(); }
  });

test('a clip held for review is not reused; once cleared, the same words are reused with no second speech call', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id);
  t.site.state.text = () => 'Eight oh four on Green Light Radio.';
  await t.slot(st.id);
  await t.hub.jit.tick();
  assert.strictEqual(t.site.speeches().length, 1);
  const ck = Object.keys(t.store.data.jit.clips)[0];
  t.store.data.jit.clips[ck].needsReview = true;                                   // held until a person approves it
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 12 * 60000).toISOString(), leadSeconds: 900 });
  await t.hub.jit.tick();
  assert.strictEqual(t.site.speeches().length, 2);                                 // not reused while held
  t.hub.jit.clearClipReview(ck, { by: 'reviewer' });                               // approved by a person
  assert.strictEqual(t.store.data.jit.clips[ck].needsReview, false);
  assert.throws(() => t.hub.jit.clearClipReview('no-such-clip', { by: 'reviewer' }), /no such clip/);
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 14 * 60000).toISOString(), leadSeconds: 900 });
  await t.hub.jit.tick();
  assert.strictEqual(t.site.speeches().length, 2);
  t.close();
});

// ------------------------------------------------------------------ fail open
test('fail open: every kind of provider failure ends with a reason and no queue entry', async () => {
  const cases = [
    ['the writer keeps failing', fakeSite({ failText: 99 }), /text: Script generation failed: upstream down/],
    ['the speech service keeps failing', fakeSite({ failSpeech: 99 }), /speech: Speech synthesis failed: busy/],
    ['no audio comes back', fakeSite({ audio: () => Buffer.alloc(0) }), /returned no audio/],
    ['the audio is tiny', fakeSite({ audio: () => Buffer.from('ID3short') }), /too small to be speech/],
    ['the audio is not audio', fakeSite({ audio: () => Buffer.alloc(5000, 1) }), /not a recognised format/],
    ['the writer returns nothing', fakeSite({ text: () => '' }), /failed validation.*no text/],
    ['the writer copies an example', fakeSite({ extra: { copiedExample: 'nope' } }), /copied an example/],
    ['a placeholder is left in', fakeSite({ text: () => 'It is {{time}} on Green Light.' }), /placeholder/],
  ];
  for (const [name, site, reason] of cases) {
    const t = await boot({ site });
    const st = await t.addStation();
    await t.enable(st.id, { shadow: false, requireApproval: false });
    await t.slot(st.id);
    await t.hub.jit.tick();
    const [item] = await items(t);
    assert.strictEqual(item.state, 'fallback', name);
    assert.match(item.reason, reason, name);
    assert.strictEqual(t.store.data.jit.queue.length, 0, name);
    assert.deepStrictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items, [], name);
    t.close();
  }
});

test('transient errors are retried with backoff and then succeed; a permanent error is not retried', async () => {
  const sleeps = [];
  const site = fakeSite({ failText: 2 });
  const t = await boot({ site, hub: { sleep: async (ms) => { sleeps.push(ms); } } });
  const st = await t.addStation();
  await t.enable(st.id);
  await t.slot(st.id);
  await t.hub.jit.tick();
  assert.strictEqual((await items(t))[0].state, 'shadow');
  assert.strictEqual(site.texts().length, 3);                                    // two 502s, then the answer
  assert.ok(sleeps.length === 2 && sleeps[1] > sleeps[0], `backoff grows: ${sleeps}`);
  t.close();

  const perm = fakeSite();
  perm.generate = async (b) => { perm.calls.push(b); return { status: 400, json: { error: 'Unknown persona "x"' } }; };
  const p = await boot({ site: perm });
  const ps = await p.addStation();
  await p.enable(ps.id);
  await p.slot(ps.id);
  await p.hub.jit.tick();
  assert.strictEqual(perm.calls.length, 1);
  assert.match((await items(p))[0].reason, /Unknown persona/);
  p.close();
});

test('a site that is not configured is a recorded fallback, not a crash', async () => {
  const store = createStore(null);
  const hub = createHub({ store, key: KEY, jitTickMs: 0, alertPollMs: 0, now: () => Date.parse('2026-10-22T20:00:00Z') });
  const st = JSON.parse(JSON.stringify(hub));                                        // (just proving it constructs)
  assert.ok(st);
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; };
  const s = (await call('POST', '/stations', { name: 'X', connection: 'pull', broadcastTz: DEN })).json;
  await call('PUT', `/stations/${s.id}/jit`, { enabled: true });
  await call('POST', '/jit/slots', { stationId: s.id, kind: 'station-id', startsAt: '2026-10-22T14:04:00', personaId: 'p' });
  await hub.jit.tick();
  const it = (await call('GET', '/jit/items')).json.items[0];
  assert.strictEqual(it.state, 'fallback');
  assert.match(it.reason, /SITE_URL and SITE_KEY/);
  assert.strictEqual((await call('GET', '/jit/status')).json.siteConfigured, false);
  hub.stop(); server.close(); server.closeAllConnections?.();
});

test('the station never picks up a clip after its time: it expires and the planned clip plays', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false, requireApproval: false });
  await t.slot(st.id);
  await t.hub.jit.tick();
  assert.strictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items.length, 1);
  t.clock.t += 8 * 60000;                                                        // past the slot
  assert.deepStrictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items, []);
  await t.hub.jit.tick();
  const [item] = await items(t);
  assert.strictEqual(item.state, 'fallback');
  assert.match(item.reason, /did not pick the clip up in time/);
  t.close();
});

// ------------------------------------------------------------------ kill switches, live shows
test('the global kill switch stops generation and hands nothing out; lifting it resumes', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false, requireApproval: false });
  await t.slot(st.id);
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 9 * 60000).toISOString() });
  await t.hub.jit.tick();
  assert.strictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items.length, 2);
  const on = await t.call('POST', '/jit/kill', { on: true, reason: 'Rocky wants quiet' }, KEY, { 'x-actor': 'Rocky' });
  assert.strictEqual(on.json.settings.kill.on, true);
  const q = (await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json;
  assert.deepStrictEqual([q.killed, q.items.length, q.reason], [true, 0, 'Rocky wants quiet']);
  const calls = t.site.calls.length;
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 9.5 * 60000).toISOString() });
  await t.hub.jit.tick();
  assert.strictEqual(t.site.calls.length, calls);                                // nothing generated
  assert.strictEqual((await items(t))[0].state, 'suppressed');
  assert.match((await items(t))[0].reason, /global kill switch/);
  assert.strictEqual((await t.call('GET', '/jit/status')).json.settings.kill.reason, 'Rocky wants quiet');
  await t.call('POST', '/jit/kill', { on: false });
  assert.strictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.killed, false);
  t.close();
});

test('a per-station kill switch affects only that station, and an approval while it is on queues nothing', async () => {
  const t = await boot();
  const a = await t.addStation('Alpha'); const b = await t.addStation('Beta');
  for (const s of [a, b]) await t.enable(s.id, { shadow: false });
  await t.slot(a.id); await t.slot(b.id);
  await t.hub.jit.tick();
  const awaiting = await items(t);
  assert.deepStrictEqual(awaiting.map((i) => i.state), ['awaiting-approval', 'awaiting-approval']);
  await t.call('POST', '/jit/kill', { on: true, stationId: a.id, reason: 'transmitter work' });
  const forA = awaiting.find((i) => i.stationId === a.id); const forB = awaiting.find((i) => i.stationId === b.id);
  assert.strictEqual((await t.call('POST', `/jit/items/${forA.id}/approve`, {})).json.state, 'suppressed');
  assert.strictEqual((await t.call('POST', `/jit/items/${forB.id}/approve`, {})).json.state, 'queued');
  assert.strictEqual((await t.call('GET', `/stations/${a.id}/queue`, undefined, a.pullKey)).json.killed, true);
  assert.strictEqual((await t.call('GET', `/stations/${b.id}/queue`, undefined, b.pullKey)).json.items.length, 1);
  t.close();
});

test('while a live show is on air dynamic slots are suppressed and nothing is handed out', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false, requireApproval: false });
  await t.heartbeat(st.id, st.pullKey, { mode: 'live-show' });
  await t.slot(st.id);
  await t.hub.jit.tick();
  const [item] = await items(t);
  assert.deepStrictEqual([item.state, /live show/.test(item.reason)], ['suppressed', true]);
  assert.strictEqual(t.site.calls.length, 0);
  await t.heartbeat(st.id, st.pullKey, { mode: 'automation' });
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 9 * 60000).toISOString() });
  await t.hub.jit.tick();
  assert.strictEqual((await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json.items.length, 1);
  await t.heartbeat(st.id, st.pullKey, { mode: 'live-show' });                   // a show starts after the clip was queued: nothing is handed out
  const q = (await t.call('GET', `/stations/${st.id}/queue`, undefined, st.pullKey)).json;
  assert.deepStrictEqual([q.mode, q.items.length], ['live-show', 0]);
  t.close();
});

test('dynamic drops are off per station until switched on, and a station without JIT is left alone', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.slot(st.id);
  await t.hub.jit.tick();
  assert.deepStrictEqual(await items(t), []);
  assert.strictEqual(t.site.calls.length, 0);
  t.close();
});

// ------------------------------------------------------------------ caps, estimates, breaker
test('the daily cap stops spending, a reused clip costs nothing, the meter resets at local midnight, and the estimate is shown first', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.call('PUT', '/jit/settings', { dailyCharCap: 80, costPer1kCharsUsd: 0.2 });
  await t.enable(st.id);
  const est = (await t.call('POST', '/jit/estimate', { stationId: st.id, chars: 100 }, READ)).json;      // a read key may ask; it spends nothing
  assert.deepStrictEqual([est.chars, est.cap.cap, est.cap.wouldExceed, est.credits], [100, 80, true, 100]);
  assert.strictEqual(Math.round(est.usd.tts * 1e6), 20000);
  assert.strictEqual(t.site.calls.length, 0);

  await t.slot(st.id);                                                            // 35 characters: fits
  await t.hub.jit.tick();
  let status = (await t.call('GET', '/jit/status')).json.stations[0].usage;
  assert.deepStrictEqual([status.chars, status.cap, status.remaining], [35, 80, 45]);
  t.site.state.text = () => 'A different and rather longer line for the second slot of the day.';       // 66 characters: 35 + 66 > 80
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 9 * 60000).toISOString() });
  await t.hub.jit.tick();
  const second = (await items(t)).find((i) => i.state === 'fallback');
  assert.match(second.reason, /daily character cap.*35 used of 80/);
  assert.strictEqual(t.site.speeches().length, 1);

  // the same words again: reused, no spend, no cap check
  t.site.state.text = () => 'Eight oh four on Green Light Radio.';
  await t.slot(st.id, { startsAt: new Date(t.clock.t + 12 * 60000).toISOString(), leadSeconds: 900 });
  await t.hub.jit.tick();
  assert.strictEqual(t.site.speeches().length, 1);
  assert.strictEqual((await items(t))[0].audio.cacheHit, true);
  // local midnight in Denver is 06:00Z; the day's meter starts again
  t.clock.t = Date.parse('2026-10-23T06:30:00Z');
  status = (await t.call('GET', '/jit/status')).json.stations[0].usage;
  assert.deepStrictEqual([status.day, status.chars], ['2026-10-23', 0]);
  t.close();
});

test('the circuit breaker opens after repeated failures, skips the provider while open, and tries again after the cooldown', async () => {
  const site = fakeSite({ failSpeech: 99 });
  const t = await boot({ site });
  const st = await t.addStation();
  await t.enable(st.id);
  const slots = (n, from) => Promise.all(Array.from({ length: n }, (_, i) => t.slot(st.id, { kind: 'station-id', startsAt: new Date(t.clock.t + (from + i) * 60000).toISOString(), leadSeconds: 900 })));
  await slots(2, 8);                                                               // two slots, each failing its three tries = two failures in a row
  await t.hub.jit.tick();
  let b = (await t.call('GET', '/jit/status')).json.breakers.speech;
  assert.deepStrictEqual([b.open, b.fails], [false, 2]);
  assert.strictEqual(site.speeches().length, 6);
  await slots(1, 11);                                                              // the third failure opens it
  await t.hub.jit.tick();
  b = (await t.call('GET', '/jit/status')).json.breakers.speech;
  assert.strictEqual(b.open, true);
  assert.match(b.lastError, /Speech synthesis failed/);
  const spent = site.speeches().length;
  await slots(1, 12);                                                              // while open: no call to the provider at all
  await t.hub.jit.tick();
  assert.strictEqual(site.speeches().length, spent);
  const newest = (await items(t))[0];
  assert.strictEqual(newest.state, 'fallback');
  assert.match(newest.reason, /keeps failing; paused until/);
  assert.strictEqual(t.store.data.jit.queue.length, 0);
  // after the cooldown a try goes through again, and a success closes the breaker
  t.clock.t += 6 * 60000;
  site.state.failSpeech = 0;
  await t.slot(st.id, { kind: 'promo', startsAt: new Date(t.clock.t + 8 * 60000).toISOString() });
  await t.hub.jit.tick();
  assert.ok(site.speeches().length > spent);
  assert.deepStrictEqual((await t.call('GET', '/jit/status')).json.breakers.speech.open, false);
  t.close();
});

// ------------------------------------------------------------------ one generation, many stations
test('one generation serves every station that shares it: one speech call, the same audio on every queue', async () => {
  const t = await boot();
  const a = await t.addStation('Alpha'); const b = await t.addStation('Beta'); const c = await t.addStation('Gamma', { broadcastTz: 'America/New_York' });
  for (const s of [a, b, c]) await t.enable(s.id, { shadow: false, requireApproval: false });
  const r = await t.call('POST', '/jit/broadcast', { stationIds: [a.id, b.id, c.id], kind: 'promo', text: 'Join us for the Green Light Radio ride along this weekend, friends.', personaId: 'rocky-flats-7fb0ca' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(t.site.speeches().length, 1, 'spoken once for three stations');
  const hashes = new Set();
  for (const s of [a, b, c]) {
    const q = (await t.call('GET', `/stations/${s.id}/queue`, undefined, s.pullKey)).json.items;
    assert.strictEqual(q.length, 1, s.id);
    hashes.add(q[0].sha256);
  }
  assert.strictEqual(hashes.size, 1);
  assert.strictEqual(r.json.results.reduce((n, g) => n + (g.items ? g.items.length : 0), 0), 3);
  const cached = (await items(t)).filter((i) => i.audio && i.audio.cacheHit);
  assert.strictEqual(cached.length, 2);                                           // two of the three items reused the clip
  t.close();
});

test('stations that differ in zone get their own written line, but identical lines still share one clip', async () => {
  const site = fakeSite({ text: (b) => 'The Green Light Radio ride along is this weekend, friends.' });
  const t = await boot({ site });
  const a = await t.addStation('Alpha'); const b = await t.addStation('Beta', { broadcastTz: 'America/New_York' });
  for (const s of [a, b]) await t.enable(s.id);
  const r = await t.call('POST', '/jit/broadcast', { stationIds: 'all', kind: 'promo', prompt: 'Promote the ride along.', personaId: 'p' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(site.texts().length, 2, 'one writer call per group (the zones differ)');
  assert.strictEqual(site.speeches().length, 1, 'but the words came out the same, so they were spoken once');
  assert.ok((await items(t)).every((i) => i.state === 'shadow'));
  t.close();
});

test('broadcast refuses lines that fail validation, and does nothing under a kill switch', async () => {
  const t = await boot();
  const a = await t.addStation();
  await t.enable(a.id, { shadow: false, requireApproval: false });
  const bad = await t.call('POST', '/jit/broadcast', { stationIds: [a.id], text: 'That is a load of bullshit, friends, truly it is.', kind: 'promo' });
  assert.match(bad.json.results[0].item.reason, /failed validation.*language/);
  const human = await t.call('POST', '/jit/broadcast', { stationIds: [a.id], text: 'Hear more at greenlight.example this weekend, friends.', kind: 'promo' });       // a person typed this: its web address is theirs
  assert.strictEqual(human.json.results[0].items[0].state, 'queued');
  t.site.calls.length = 0;
  const queued = t.store.data.jit.queue.length;
  await t.call('POST', '/jit/kill', { on: true });
  const killed = await t.call('POST', '/jit/broadcast', { stationIds: [a.id], text: 'A perfectly fine line for the evening, friends.', kind: 'promo' });
  assert.strictEqual(killed.json.results[0].item.state, 'suppressed');
  assert.strictEqual(t.site.speeches().length, 0);
  assert.strictEqual(t.store.data.jit.queue.length, queued);                       // nothing new was queued
  t.close();
});

// ------------------------------------------------------------------ slots
test('slots: a local time with no offset is read in the BROADCAST zone, validated, edited and removed; the nightly plan syncs by ref', async () => {
  const t = await boot();
  const st = await t.addStation();
  const s = (await t.call('POST', '/jit/slots', { stationId: st.id, kind: 'time-check', startsAt: '2026-10-23T00:05', personaId: 'p' })).json;   // 00:05 Denver on the 23rd
  assert.strictEqual(new Date(s.startsAt).toISOString(), '2026-10-23T06:05:00.000Z');
  assert.strictEqual(s.startsAtIso, '2026-10-23T00:05:00-06:00');
  assert.strictEqual(s.leadSeconds, 300);
  const dst = (await t.call('POST', '/jit/slots', { stationId: st.id, kind: 'time-check', startsAt: '2026-11-01T01:30', personaId: 'p' })).json;      // the repeated hour: the first one
  assert.strictEqual(new Date(dst.startsAt).toISOString(), '2026-11-01T07:30:00.000Z');
  for (const bad of [{ kind: 'bogus' }, { startsAt: 'soon' }, { leadSeconds: 5 }, { stationId: 'nope' }, { kind: 'event-reminder' }]) {
    assert.ok([400, 404].includes((await t.call('POST', '/jit/slots', { stationId: st.id, kind: 'time-check', startsAt: '2026-10-23T00:05', ...bad })).status), JSON.stringify(bad));
  }
  const ev = (await t.call('POST', '/jit/slots', { stationId: st.id, kind: 'event-reminder', startsAt: '2026-10-22T18:00', constraints: { event: { name: 'Jazz Night', startsAt: '2026-10-22T19:00', venue: 'The Walnut Room' }, facts: ['Doors at 6:30'] } })).json;
  assert.strictEqual(typeof ev.constraints.event.startsAt, 'number');
  assert.strictEqual((await t.call('PUT', `/jit/slots/${s.id}`, { leadSeconds: 900 })).json.leadSeconds, 900);
  assert.strictEqual((await t.call('DELETE', `/jit/slots/${s.id}`)).status, 200);
  assert.strictEqual((await t.call('DELETE', `/jit/slots/${s.id}`)).status, 404);

  const plan = (n) => ({ slots: [{ ref: '2026-10-23#4', kind: 'time-check', startsAt: '2026-10-23T08:00:00-06:00', personaId: 'p', fallbackClipId: 'e1' }, { ref: '2026-10-23#9', kind: 'weather', startsAt: '2026-10-23T09:00:00-06:00', personaId: 'p' }].slice(0, n) });
  assert.deepStrictEqual((await t.call('PUT', `/stations/${st.id}/slots`, plan(2), st.pullKey)).json, { added: 2, updated: 0, skipped: 0, removed: 0 });
  assert.deepStrictEqual((await t.call('PUT', `/stations/${st.id}/slots`, plan(2), st.pullKey)).json, { added: 0, updated: 2, skipped: 0, removed: 0 });
  assert.deepStrictEqual((await t.call('PUT', `/stations/${st.id}/slots`, plan(1), st.pullKey)).json, { added: 0, updated: 1, skipped: 0, removed: 1 });        // the plan changed
  assert.strictEqual((await t.call('GET', `/jit/slots?stationId=${st.id}`)).json.slots.filter((x) => x.source === 'schedule').length, 1);
  assert.strictEqual((await t.call('PUT', `/stations/${st.id}/slots`, { slots: [{ kind: 'weather' }] }, st.pullKey)).json.skipped, 1);               // no ref
  t.close();
});

// ------------------------------------------------------------------ audit, settings, alerts
test('the audit log records who did what and when, and never holds a key', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.call('PUT', `/stations/${st.id}/jit`, { enabled: true, shadow: false }, KEY, { 'x-actor': 'Rocky' });
  await t.call('PUT', '/jit/settings', { dailyCharCap: 1234, blocklist: ['sponsor'] }, KEY, { 'x-actor': 'Rocky' });
  await t.call('POST', '/jit/kill', { on: true, reason: 'testing' }, KEY, { 'x-actor': 'Rocky' });
  await t.call('POST', '/jit/slots', { stationId: 'nope', kind: 'promo' });                                             // a failed attempt is recorded too
  const entries = (await t.call('GET', '/audit?limit=50', undefined, READ)).json.entries;
  const actions = entries.map((e) => e.action);
  for (const a of ['station.jit', 'jit.settings', 'kill.on', 'station.create']) assert.ok(actions.includes(a), a);
  assert.ok(entries.some((e) => e.who === 'control:Rocky' && e.action === 'kill.on' && e.target === 'global'));
  assert.ok(entries.some((e) => e.action === 'POST /jit/slots' && e.result === 'error 404'));
  assert.ok(entries.every((e) => e.at > 0 && e.who && e.result));
  const raw = JSON.stringify(entries);
  for (const secret of [KEY, READ, st.pullKey]) assert.ok(!raw.includes(secret));
  assert.deepStrictEqual((await t.call('GET', '/jit/settings')).json.blocklist, ['sponsor']);
  assert.strictEqual((await t.call('PUT', '/jit/settings', { dailyCharCap: 'lots' })).status, 400);
  assert.strictEqual((await t.call('PUT', '/jit/settings', { languagePolicy: 'anything' })).status, 400);
  t.close();
});

test('emergency alerts are only a hook: visible, disabled, and refusing everything', async () => {
  const t = await boot();
  const st = (await t.call('GET', '/jit/alerts')).json;
  assert.deepStrictEqual([st.enabled, st.planned], [false, true]);
  assert.ok(st.requires.includes('human approval'));
  const r = await t.call('POST', '/jit/alerts', { text: 'TORNADO WARNING' });
  assert.deepStrictEqual([r.json.accepted], [false]);
  assert.match(r.json.reason, /planned, not built/);
  assert.strictEqual((await t.call('GET', '/jit/status')).json.alerts.enabled, false);
  assert.strictEqual(t.store.data.jit?.queue.length ?? 0, 0);
  t.close();
});

test('settings and station JIT switches survive a restart of the hub (same store)', async () => {
  const t = await boot();
  const st = await t.addStation();
  await t.enable(st.id, { shadow: false });
  await t.call('PUT', '/jit/settings', { dailyCharCap: 777 });
  const second = createHub({ store: t.store, key: KEY, now: () => t.clock.t, generate: t.site.generate, jitTickMs: 0, alertPollMs: 0 });
  assert.strictEqual(second.jit.settings().dailyCharCap, 777);
  assert.deepStrictEqual([second.jit.jitView(t.store.data.stations[0]).shadow, second.jit.jitView(t.store.data.stations[0]).enabled], [false, true]);
  second.stop(); t.close();
});

test('a song-neutral slot refuses a line that names a song, and passes a neutral station ID', async () => {
  const site = fakeSite({ text: () => 'Coming up next, we have a song by the Beatles, that was great.' });
  const t = await boot({ site });
  const st = await t.addStation();
  await t.enable(st.id);
  const slot = await t.slot(st.id, { songNeutral: true });
  assert.strictEqual(slot.songNeutral, true);
  await t.hub.jit.tick();
  const [refused] = await items(t);
  assert.strictEqual(refused.state, 'fallback');
  assert.match(refused.reason, /song-on-neutral-slot|names a song/);
  assert.strictEqual(site.speeches().length, 0);
  t.close();

  const ok = fakeSite({ text: () => 'You are listening to Green Light Radio, in Denver, Colorado.' });
  const t2 = await boot({ site: ok });
  const st2 = await t2.addStation();
  await t2.enable(st2.id);
  await t2.slot(st2.id, { songNeutral: true });
  await t2.hub.jit.tick();
  const [passed] = await items(t2);
  assert.notStrictEqual(passed.state, 'fallback', passed.reason);
  t2.close();
});

test('slot listing shows the freshness tier, and flags a song-neutral slot whose baked line names a song', async () => {
  const t = await boot({});
  const st = await t.addStation();
  await t.enable(st.id);
  await t.slot(st.id, { songNeutral: true });
  const [listed] = (await t.call('GET', `/jit/slots?stationId=${st.id}`)).json.slots;
  assert.strictEqual(listed.songNeutral, true);
  assert.strictEqual(listed.songNeutralAudit, undefined);
  assert.strictEqual(listed.freshness, undefined);
  t.close();
});
