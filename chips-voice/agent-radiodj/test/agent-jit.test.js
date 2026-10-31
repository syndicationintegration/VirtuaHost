// Contract tests for the JIT-era agent API, against a fake RadioDJ (a local HTTP server that mimics the REST plugin) and a fake Icecast.
// Nothing here touches a real station. Anything marked "needs live verification" in the agent is verified here only against the fake.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgent, fromEnv, listenConfig, splitCommand } = require('../agent');
const { parseNow, parsePlaylist } = require('../radiodj');

const track = (artist, title, extra = {}) => ({ Artist: artist, Title: title, ...extra });

// A RadioDJ stand-in. `state.current` / `state.playlist` can be changed by a test; PlayCartByNumber "starts" the clip; the insert command
// puts an item into the playlist at the given position the way a working one would.
async function fakeRadioDJ(state = {}) {
  const s = { current: track('Boards of Canada', 'Roygbiv', { Duration: 215, Elapsed: 100, Remaining: 115, Position: 1 }), playlist: [track('Aphex Twin', 'Xtal'), track('Autechre', 'Bike'), track('Burial', 'Archangel')], calls: [], reflectInsert: true, ...state };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    s.calls.push({ path: url.pathname, ...Object.fromEntries(url.searchParams) });
    if (url.searchParams.get('auth') !== 'pw') { res.writeHead(403); return res.end('no'); }
    if (url.pathname === '/npjson') { res.writeHead(200); return res.end(JSON.stringify({ CurrentTrack: s.current, Playlist: s.playlist })); }
    if (url.pathname === '/np') { res.writeHead(200); return res.end('Fallback Artist - Fallback Title'); }
    if (url.pathname === '/opt') {
      const cmd = url.searchParams.get('command');
      if (cmd === 'PlayCartByNumber' && s.onCart) s.onCart(s);
      if (cmd === 'InsertFake' && s.reflectInsert) {
        const [file, pos, replace] = url.searchParams.get('arg').split('|');
        if (replace && s.removeReplaced !== false) { const i = s.playlist.findIndex((x) => `${x.Title} ${x.Path || ''}`.includes(replace)); if (i >= 0) s.playlist.splice(i, 1); }
        s.playlist.splice(Number(pos) - 1, 0, track('', path.basename(file, path.extname(file)), { Path: file }));
      }
    }
    res.writeHead(200); res.end('OK');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}`;
  s.close = () => { server.close(); server.closeAllConnections?.(); };
  s.commands = () => s.calls.filter((c) => c.path === '/opt');
  return s;
}

async function fakeIcecast(listeners = 7, mount = '/stream') {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ icestats: { source: [{ listenurl: `http://x:8000${mount}`, listeners }] } })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections?.(); } };
}

const clipBytes = (n) => Buffer.from(`ID3 fake audio ${n}`);

async function boot(extra = {}, radioState) {
  const radiodj = await fakeRadioDJ(radioState);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jit-'));
  const execs = [];
  const opts = {
    keys: [{ id: 'hub-a', scopes: ['read'], key: 'read-a' }, { id: 'hub-a', scopes: ['read', 'control'], key: 'control-a' }, { id: 'hub-b', scopes: ['read', 'control'], key: 'control-b' }],
    radiodjUrl: radiodj.url, radiodjPass: 'pw', linksDir: path.join(dir, 'clips'), dataDir: path.join(dir, 'data'), broadcastTz: 'America/Denver', machineTz: 'America/Chicago',
    shadow: false, insertCommand: 'InsertFake', insertArg: '{path}|{position}', confirmSeconds: 0.3, confirmPollMs: 20, sleep: () => Promise.resolve(),
    execImpl: (program, args, o, cb) => { execs.push({ program, args, o }); cb(null, 'done', ''); }, ...extra,
  };
  const agent = createAgent(opts);
  await new Promise((r) => agent.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${agent.server.address().port}`;
  const call = async (method, p, body, key = 'control-a', headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + p, { method, headers: { ...(key ? { 'x-api-key': key } : {}), ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  return { agent, call, radiodj, dir, execs, base, opts, close: () => { agent.server.close(); agent.server.closeAllConnections?.(); radiodj.close(); } };
}
const ingest = async (t, n, q = '') => (await t.call('POST', `/ingest?title=Clip${n}${q}`, clipBytes(n), 'control-a', { 'content-type': 'audio/mpeg' }));

// ---------------------------------------------------------------- parsing
test('parseNow reads CurrentTrack with Remaining, Elapsed and Duration (and still the older key names)', () => {
  const text = JSON.stringify({ Playlist: [track('Not', 'This')], CurrentTrack: track('Boards of Canada', 'Roygbiv', { Duration: 215, Elapsed: '1:40', Remaining: 115, Position: 1 }) });
  assert.deepStrictEqual(parseNow(text), { artist: 'Boards of Canada', title: 'Roygbiv', remaining: 115, elapsed: 100, duration: 215 });
  assert.strictEqual(parseNow(JSON.stringify({ CurrentTrack: track('A', 'B', { Duration: 200, Elapsed: 50 }) })).remaining, 150);      // worked out when only elapsed and duration are given
  assert.strictEqual(parseNow('{"Artist":"A","Title":"B","PlayingTrackRemainingSeconds":"42"}').remaining, 42);
  assert.strictEqual(parseNow('Plain Artist - Plain Title').title, 'Plain Title');
});

test('parsePlaylist tolerates an array, an object holding one, and nonsense', () => {
  assert.deepStrictEqual(parsePlaylist(JSON.stringify({ Playlist: [track('A', 'B', { Duration: '3:05' })] })), [{ artist: 'A', title: 'B', duration: 185, path: undefined }]);
  assert.strictEqual(parsePlaylist(JSON.stringify({ Playlist: { items: [track('A', 'B')] } })).length, 1);
  assert.deepStrictEqual(parsePlaylist('{"Playlist": "weird"}'), []);
  assert.deepStrictEqual(parsePlaylist('not json'), []);
});

test('splitCommand groups quoted words and never uses a shell', () => {
  assert.deepStrictEqual(splitCommand('python "C:\\Green Light\\insert.py" --fast'), ['python', 'C:\\Green Light\\insert.py', '--fast']);
});

// ---------------------------------------------------------------- keys, scopes, defaults
test('listens on loopback unless AGENT_HOST says otherwise', () => {
  assert.deepStrictEqual(listenConfig({}), { host: '127.0.0.1', port: 3100 });
  assert.strictEqual(listenConfig({ AGENT_HOST: '0.0.0.0', AGENT_PORT: '4000' }).host, '0.0.0.0');
});

test('separate read and control keys: reading never needs control, control is refused to a read key, and keys belong to a hub', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('GET', '/agent/info', undefined, 'read-a')).status, 200);
  assert.strictEqual((await t.call('GET', '/agent/info', undefined, '')).status, 401);
  assert.strictEqual((await t.call('GET', '/agent/info', undefined, 'nope')).status, 401);
  const denied = await t.call('POST', '/ingest', clipBytes(1), 'read-a');
  assert.strictEqual(denied.status, 403);
  assert.match(denied.json.error, /can only read/);
  assert.strictEqual((await ingest(t, 1)).status, 201);
  assert.strictEqual((await t.call('POST', '/ingest?title=b', clipBytes(2), 'control-b')).status, 201);
  const entries = (await t.call('GET', '/agent/audit?limit=10', undefined, 'read-a')).json.entries.filter((e) => e.action === 'ingest');
  assert.deepStrictEqual(entries.map((e) => [e.hub, e.result]).sort(), [['hub-a', 'ok'], ['hub-a', 'refused'], ['hub-b', 'ok']]);
  t.close();
});

test('too many wrong keys are throttled (429) and logged without the key', async () => {
  const t = await boot();
  let last;
  for (let i = 0; i < 12; i += 1) last = await t.call('GET', '/agent/info', undefined, `wrong-${i}`);
  assert.strictEqual(last.status, 429);
  const text = fs.readFileSync(path.join(t.dir, 'data', 'audit.jsonl'), 'utf8');
  assert.ok(!text.includes('wrong-'));
  assert.match(text, /"action":"auth"/);
  t.close();
});

test('control calls are rate limited per hub', async () => {
  const t = await boot({ rateControlPerMin: 3 });
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await ingest(t, i)).status);
  assert.deepStrictEqual(codes, [201, 201, 201, 429, 429]);
  assert.ok((await t.call('POST', '/ingest', clipBytes(9), 'control-a')).headers.get('retry-after'));
  assert.strictEqual((await t.call('POST', '/ingest?title=x', clipBytes(9), 'control-b')).status, 201);          // another hub has its own allowance
  assert.strictEqual((await t.call('GET', '/agent/info', undefined, 'read-a')).status, 200);                      // and reading is separate
  t.close();
});

test('the allowlist narrows what a hub may do', async () => {
  const t = await boot({ allow: ['ingest'] });
  assert.strictEqual((await ingest(t, 1)).status, 201);
  const r = await t.call('POST', '/queue/insert', { clip: 'x' });
  assert.strictEqual(r.status, 403);
  assert.match(r.json.error, /allowlist/);
  t.close();
});

// ---------------------------------------------------------------- the two clocks
test('/agent/info carries machineTz and broadcastTz, and warns when they differ or the PC offset does not match', async () => {
  const t = await boot({ now: () => Date.parse('2026-10-22T20:00:00Z') });
  const info = (await t.call('GET', '/agent/info', undefined, 'read-a')).json;
  assert.strictEqual(info.machineTz, 'America/Chicago');
  assert.strictEqual(info.broadcastTz, 'America/Denver');
  assert.strictEqual(info.machineNow, '2026-10-22T15:00:00-05:00');
  assert.strictEqual(info.broadcastNow, '2026-10-22T14:00:00-06:00');
  const codes = info.warnings.map((w) => w.code);
  assert.ok(codes.includes('zones-differ'));
  // This test machine's own clock is whatever the CI box uses: the offset warning appears exactly when it differs from Chicago's.
  const here = -new Date(Date.parse('2026-10-22T20:00:00Z')).getTimezoneOffset();
  assert.strictEqual(codes.includes('pc-offset-mismatch'), here !== -300);
  t.close();
  assert.throws(() => createAgent({ key: 'k', machineTz: 'Mars/Base' }), /MACHINE_TZ/);
  assert.throws(() => createAgent({ key: 'k', broadcastTz: 'Nope' }), /BROADCAST_TZ/);
});

// ---------------------------------------------------------------- status
test('/agent/status: stream, listeners, playlist, now playing with elapsed/remaining, next 5, watchdog, mode, shadow, kill switch', async () => {
  const ice = await fakeIcecast(9);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'));
  fs.writeFileSync(path.join(dir, 'watchdog.json'), JSON.stringify({ lastRestartAt: '2026-10-22T03:11:00-06:00', reason: 'stream silent 90s' }));
  fs.writeFileSync(path.join(dir, 'loaded.txt'), 'GLR 2026-10-22');
  const six = Array.from({ length: 7 }, (_, i) => track(`Artist ${i}`, `Song ${i}`));
  const t = await boot({ icecastUrl: ice.url, watchdogFile: path.join(dir, 'watchdog.json'), loadedPlaylistFile: path.join(dir, 'loaded.txt'), shadow: true }, { playlist: six });
  const st = (await t.call('GET', '/agent/status', undefined, 'read-a')).json;
  assert.deepStrictEqual(st.stream, { up: true, listeners: 9, mount: '/stream' });
  assert.deepStrictEqual(st.nowPlaying, { artist: 'Boards of Canada', title: 'Roygbiv', elapsedSeconds: 100, remainingSeconds: 115, durationSeconds: 215 });
  assert.strictEqual(st.next.length, 5);
  assert.strictEqual(st.next[0].title, 'Song 0');
  assert.strictEqual((await t.call('GET', '/agent/status?next=2', undefined, 'read-a')).json.next.length, 2);
  assert.deepStrictEqual(st.playlist, { loaded: 'GLR 2026-10-22', source: 'file' });
  assert.deepStrictEqual(st.lastWatchdogRestart, { lastRestartAt: '2026-10-22T03:11:00-06:00', reason: 'stream silent 90s' });
  assert.deepStrictEqual([st.mode, st.shadow, st.killSwitch.on, st.machineTz, st.broadcastTz], ['automation', true, false, 'America/Chicago', 'America/Denver']);
  assert.ok(st.needsLiveVerification.includes('queueInsert'));
  ice.close(); t.close();
});

test('/agent/status reports a stream that is down, an unreachable Icecast, and an unreachable RadioDJ without failing', async () => {
  const t = await boot({ icecastUrl: 'http://127.0.0.1:1', radiodjPass: 'wrong' });
  const st = (await t.call('GET', '/agent/status', undefined, 'read-a')).json;
  assert.strictEqual(st.stream.up, false);
  assert.match(st.stream.error, /not reachable/);
  assert.strictEqual(st.reachable, false);
  assert.match(st.error, /cannot reach RadioDJ/);
  t.close();
});

// ---------------------------------------------------------------- schedule
test('/schedule?date= lists the day with kinds, converts times in the BROADCAST zone, and defaults to the broadcast date at midnight rollover', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sched-'));
  fs.writeFileSync(path.join(dir, 'GLR 2026-10-22.json'), JSON.stringify({ name: 'GLR 2026-10-22', items: [
    { time: '19:00:00', kind: 'song', artist: 'A', title: 'B', durationSeconds: 200 },
    { startsAt: '2026-10-22T19:03:20-06:00', kind: 'interlude', title: 'Bumper' },
    { time: '19:04:00', kind: 'dynamic-slot', dynamic: { slotKind: 'time-check', personaId: 'rocky-flats-7fb0ca', leadSeconds: 600, fallbackClipId: 'evergreen-time-1' } },
    { time: '19:05:00', kind: 'host-break' }, { time: '19:06:00', kind: 'segment' }, { time: '19:07:00', kind: 'drop' }, { time: '19:08:00', kind: 'bogus' },
  ] }));
  // 05:30Z on the 23rd: 23:30 on the 22nd in Denver, but already 00:30 on the 23rd on the Central PC.
  const t = await boot({ scheduleDir: dir, now: () => Date.parse('2026-10-23T05:30:00Z') });
  const day = (await t.call('GET', '/schedule', undefined, 'read-a')).json;
  assert.strictEqual(day.date, '2026-10-22');
  assert.strictEqual(day.available, true);
  assert.deepStrictEqual(day.items.map((i) => i.kind), ['song', 'interlude', 'dynamic-slot', 'host-break', 'segment', 'drop', 'song']);
  assert.strictEqual(day.items[0].startsAt, '2026-10-22T19:00:00-06:00');
  assert.strictEqual(day.items[2].dynamic.slotKind, 'time-check');
  assert.strictEqual(day.items[2].dynamic.leadSeconds, 600);
  assert.strictEqual(day.items[2].dynamic.fallbackClipId, 'evergreen-time-1');
  const none = (await t.call('GET', '/schedule?date=2026-10-24', undefined, 'read-a')).json;
  assert.deepStrictEqual([none.available, none.items.length], [false, 0]);
  assert.strictEqual((await t.call('GET', '/schedule?date=tomorrow', undefined, 'read-a')).status, 400);
  assert.strictEqual((await t.call('POST', '/schedule', {})).status, 404);                                       // read-only
  t.close();
});

test('the schedule shows a 23-hour day on the spring DST change in Denver', async () => {
  const t = await boot({ scheduleDir: os.tmpdir() });
  const day = (await t.call('GET', '/schedule?date=2026-03-08', undefined, 'read-a')).json;
  assert.strictEqual(day.dayHours, 23);
  t.close();
});

// ---------------------------------------------------------------- ingest
test('ingest gives every clip its own hash-based file name instead of one fixed file', async () => {
  const t = await boot();
  const a = await ingest(t, 1); const b = await ingest(t, 2); const again = await ingest(t, 1);
  assert.notStrictEqual(a.json.clip.file, b.json.clip.file);
  assert.strictEqual(a.json.clip.file, again.json.clip.file);
  assert.match(a.json.clip.file, /^[0-9a-f]{16}\.mp3$/);
  assert.deepStrictEqual(fs.readFileSync(path.join(t.dir, 'clips', a.json.clip.file)), clipBytes(1));
  assert.deepStrictEqual(fs.readdirSync(path.join(t.dir, 'clips')).sort(), [a.json.clip.file, b.json.clip.file].sort());
  assert.ok(!fs.existsSync(path.join(t.dir, 'clips', 'current_link.mp3')));                                    // no fixed file unless a cart needs one
  t.close();
});

test('the clip folder defaults under GreenLightRadio, never KRAP', () => {
  const cfg = fromEnv({ AGENT_KEY: 'k' });
  assert.strictEqual(cfg.linksDir, undefined);                                    // so createAgent's default applies
  const probe = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  assert.match(probe, /GreenLightRadio/);
  assert.ok(!/C:\\\\KRAP/.test(probe));
});

test('a damaged upload (wrong sha256) is refused before anything is stored as that clip', async () => {
  const t = await boot();
  const bad = await t.call('POST', '/ingest?sha256=deadbeef', clipBytes(5), 'control-a', { 'content-type': 'audio/mpeg' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /sha256/);
  t.close();
});

test('generated clips are NOT fired in shadow mode, and are confirmed through /npjson when live (played: true | false)', async () => {
  let t = await boot({ shadow: true, clipCart: '7' });
  const shadow = await ingest(t, 1, '&play=1&generated=1');
  assert.strictEqual(shadow.status, 202);
  assert.deepStrictEqual([shadow.json.shadow, shadow.json.executed, shadow.json.fired, shadow.json.played], [true, false, false, false]);
  assert.strictEqual(t.radiodj.commands().length, 0);
  t.close();

  // live, and the cart really starts the clip: the fake changes the current track when PlayCartByNumber arrives
  t = await boot({ shadow: false, clipCart: '7' }, { onCart: (s) => { s.current = track('', 'Clip2', { Elapsed: 1, Duration: 8, Remaining: 7 }); } });
  const ok = await ingest(t, 2, '&play=1&generated=1');
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual([ok.json.fired, ok.json.played], [true, true]);
  assert.deepStrictEqual(t.radiodj.commands().map((c) => [c.command, c.arg]), [['PlayCartByNumber', '7']]);
  assert.ok(fs.existsSync(path.join(t.dir, 'clips', 'current_link.mp3')));                                      // the cart's fixed file is still supported
  t.close();

  // live, but nothing started: fired, not played
  t = await boot({ shadow: false, clipCart: '7' });
  const silent = await ingest(t, 3, '&play=1&generated=1');
  assert.deepStrictEqual([silent.json.fired, silent.json.played], [true, false]);
  t.close();

  // ordinary (non-generated) clips behave as before: no confirmation, no shadow
  t = await boot({ shadow: true, clipCart: '7' });
  const legacy = await ingest(t, 4, '&play=1');
  assert.deepStrictEqual([legacy.status, legacy.json.played], [200, true]);
  t.close();
});

// ---------------------------------------------------------------- queue insert
test('/queue/insert never goes in the immediately-next slot, and says why', async () => {
  const t = await boot();
  const clip = (await ingest(t, 1)).json.clip;
  for (const ahead of [0, 1, -3, 1.5, 'two']) {
    const r = await t.call('POST', '/queue/insert', { clip: clip.id, ahead });
    assert.strictEqual(r.status, 400, `ahead=${ahead}`);
    assert.match(r.json.error, /at least 2/);
  }
  assert.strictEqual(t.radiodj.commands().length, 0);
  t.close();
});

test('/queue/insert puts the clip 2 ahead through the configured command, reads the queue back, and is idempotent by clip hash', async () => {
  const t = await boot();
  const clip = (await ingest(t, 1)).json.clip;
  const first = await t.call('POST', '/queue/insert', { clip: clip.id });
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual([first.json.inserted, first.json.position, first.json.verified, first.json.unverified], [true, 2, true, ['queueInsert']]);
  const cmds = t.radiodj.commands();
  assert.strictEqual(cmds.length, 1);
  assert.strictEqual(cmds[0].command, 'InsertFake');
  assert.strictEqual(cmds[0].arg, `${path.join(t.dir, 'clips', clip.file)}|2`);
  const second = await t.call('POST', '/queue/insert', { clip: clip.id });
  assert.deepStrictEqual([second.status, second.json.duplicate, second.json.position], [200, true, 2]);
  assert.strictEqual(t.radiodj.commands().length, 1);                                                          // no second command
  const byHash = await t.call('POST', '/queue/insert', { sha256: clip.sha256 });
  assert.strictEqual(byHash.json.duplicate, true);
  // a restart does not forget it
  const again = createAgent({ ...t.opts, keys: t.opts.keys });
  await new Promise((r) => again.server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${again.server.address().port}/queue/insert`, { method: 'POST', headers: { 'x-api-key': 'control-a', 'content-type': 'application/json' }, body: JSON.stringify({ sha256: clip.sha256 }) });
  assert.strictEqual((await res.json()).duplicate, true);
  again.server.close(); again.server.closeAllConnections?.();
  t.close();
});

test('/queue/insert: a later position, a queue that is too short, an unknown clip, and nothing configured', async () => {
  let t = await boot();
  const clip = (await ingest(t, 1)).json.clip;
  assert.strictEqual((await t.call('POST', '/queue/insert', { clip: clip.id, ahead: 3 })).json.position, 3);
  assert.strictEqual((await t.call('POST', '/queue/insert', { clip: 'nope' })).status, 404);
  t.close();

  t = await boot({}, { playlist: [] });                                                                          // nothing queued ahead
  const c2 = (await ingest(t, 2)).json.clip;
  const short = await t.call('POST', '/queue/insert', { clip: c2.id });
  assert.strictEqual(short.status, 409);
  assert.strictEqual(short.json.reason, 'queue-too-short');
  assert.strictEqual(t.radiodj.commands().length, 0);                                                            // fail open: nothing was changed
  t.close();

  t = await boot({ insertCommand: '', clipCart: '7' });
  const c3 = (await ingest(t, 3)).json.clip;
  assert.strictEqual((await t.call('POST', '/queue/insert', { clip: c3.id })).status, 501);
  t.close();
});

test('/queue/insert through a local script runs it with arguments, no shell, and reports an unverified result when the queue cannot be read back', async () => {
  const t = await boot({ insertCommand: '', insertExec: 'python "C:\\Green Light\\insert_clip.py"' }, { playlist: [track('A', 'B'), track('', 'evergreen-time-1', { Path: 'evergreen-time-1.mp3' })] });
  const clip = (await ingest(t, 1)).json.clip;
  const r = await t.call('POST', '/queue/insert', { clip: clip.id, ahead: 2, replace: 'evergreen-time-1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(t.execs.length, 1);
  assert.deepStrictEqual([t.execs[0].program, t.execs[0].args.slice(0, 1), t.execs[0].args.slice(2), t.execs[0].o.shell], ['python', ['C:\\Green Light\\insert_clip.py'], ['2', 'evergreen-time-1'], false]);
  assert.strictEqual(r.json.verified, false);                                                                   // the script ran, but the fake queue does not show the clip
  assert.strictEqual(r.json.replaced, false);                                                                   // and the planned clip is still there: reported, not hidden
  t.close();
});

test('in shadow mode an insert is checked and logged but nothing is executed', async () => {
  const t = await boot({ shadow: true });
  const clip = (await ingest(t, 1)).json.clip;
  const r = await t.call('POST', '/queue/insert', { clip: clip.id });
  assert.deepStrictEqual([r.status, r.json.shadow, r.json.executed], [202, true, false]);
  assert.strictEqual(t.radiodj.commands().length, 0);
  assert.strictEqual(t.execs.length, 0);
  assert.strictEqual((await t.call('GET', '/agent/audit', undefined, 'read-a')).json.entries[0].result, 'shadow');
  t.close();
});

// ---------------------------------------------------------------- playlist load
test('only playlists named "GLR YYYY-MM-DD*" can be loaded, through the configured script', async () => {
  const t = await boot({ loadExec: 'C:\\GreenLightRadio\\load_playlist.cmd' });
  for (const name of ['Rock', 'GLR 2026-10-22; del *', '../GLR 2026-10-22', 'glr 2026-10-22', '']) assert.strictEqual((await t.call('POST', '/playlist/load', { name })).status, 400, name);
  assert.strictEqual(t.execs.length, 0);
  const ok = await t.call('POST', '/playlist/load', { name: 'GLR 2026-10-22' });
  assert.deepStrictEqual([ok.status, ok.json.loaded, ok.json.unverified], [200, 'GLR 2026-10-22', ['playlistLoad']]);
  assert.deepStrictEqual(t.execs[0].args, ['GLR 2026-10-22']);
  assert.strictEqual((await t.call('POST', '/playlist/load', { name: 'GLR 2026-10-23 late' })).status, 200);
  assert.strictEqual((await t.call('GET', '/agent/status', undefined, 'read-a')).json.playlist.loaded, 'GLR 2026-10-23 late');
  t.close();
  const bare = await boot();
  assert.strictEqual((await bare.call('POST', '/playlist/load', { name: 'GLR 2026-10-22' })).status, 501);
  bare.close();
});

// ---------------------------------------------------------------- kill switch, live show
test('the kill switch (file flag) makes the agent reject every control call, while reads keep working', async () => {
  const t = await boot();
  const clip = (await ingest(t, 1)).json.clip;
  fs.mkdirSync(path.join(t.dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'data', 'KILL'), 'Rocky said stop');
  const calls = [['POST', '/ingest?title=x', clipBytes(2)], ['POST', '/clips/' + clip.id + '/play'], ['POST', '/queue/insert', { clip: clip.id }], ['POST', '/playlist/load', { name: 'GLR 2026-10-22' }], ['POST', '/music/skip'], ['POST', '/music/volume', { volume: 1 }]];
  for (const [m, p, b] of calls) {
    const r = await t.call(m, p, b);
    assert.strictEqual(r.status, 423, p);
    assert.match(r.json.error, /kill switch is on.*Rocky said stop/);
  }
  assert.strictEqual(t.radiodj.commands().length, 0);
  const st = (await t.call('GET', '/agent/status', undefined, 'read-a')).json;
  assert.deepStrictEqual([st.killSwitch.on, st.killSwitch.reason], [true, 'Rocky said stop']);
  const refused = (await t.call('GET', '/agent/audit?limit=20', undefined, 'read-a')).json.entries.filter((e) => e.result === 'refused');
  assert.ok(refused.length >= calls.length);
  assert.ok(refused.every((e) => e.status === 423));
  fs.unlinkSync(path.join(t.dir, 'data', 'KILL'));                                                              // lifted on the PC
  assert.strictEqual((await ingest(t, 3)).status, 201);
  t.close();
});

test('the kill switch can be switched on over the API but only off on the PC', async () => {
  const t = await boot();
  const on = await t.call('POST', '/agent/kill', { on: true, reason: 'hub says stop' });
  assert.strictEqual(on.json.killSwitch.on, true);
  assert.ok(fs.existsSync(path.join(t.dir, 'data', 'KILL')));
  assert.strictEqual((await ingest(t, 1)).status, 423);
  const off = await t.call('POST', '/agent/kill', { on: false });
  assert.strictEqual(off.status, 403);
  assert.match(off.json.error, /on the PC/);
  assert.strictEqual((await t.call('POST', '/agent/kill', { on: true }, 'read-a')).status, 403);               // a read key cannot even switch it on
  t.close();
});

test('control is refused while a live show is on; it can be entered remotely but only left on the PC', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('POST', '/agent/mode', { mode: 'live-show' })).json.mode, 'live-show');
  const r = await ingest(t, 1);
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /live show/);
  assert.strictEqual((await t.call('GET', '/music/now', undefined, 'read-a')).json.live, true);
  assert.strictEqual((await t.call('POST', '/agent/mode', { mode: 'automation' })).status, 403);
  fs.writeFileSync(path.join(t.dir, 'data', 'mode'), 'automation');
  assert.strictEqual((await ingest(t, 2)).status, 201);
  t.close();
});

// ---------------------------------------------------------------- audit log
test('the audit log records who, what, when and the result, is append-only on disk, and holds no secrets', async () => {
  const t = await boot({ now: () => Date.parse('2026-10-22T20:00:00Z') });
  await t.call('POST', '/ingest?title=' + encodeURIComponent('hello https://x.test/a?token=SECRET123'), clipBytes(1), 'control-a', { 'content-type': 'audio/mpeg' });
  await t.call('POST', '/ingest', clipBytes(2), 'read-a');
  const file = path.join(t.dir, 'data', 'audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => [l.hub, l.action, l.result, l.status]), [['hub-a', 'ingest', 'ok', 201], ['hub-a', 'ingest', 'refused', 403]]);
  assert.strictEqual(lines[0].at, '2026-10-22T20:00:00.000Z');
  const raw = fs.readFileSync(file, 'utf8');
  for (const secret of ['SECRET123', 'control-a', 'read-a']) assert.ok(!raw.includes(secret), secret);
  const before = fs.statSync(file).size;
  await ingest(t, 3);
  assert.ok(fs.statSync(file).size > before);                                                                    // it only grows
  t.close();
  const reopened = createAgent({ ...t.opts });
  assert.strictEqual(reopened.audit.tail(10).length, 3);                                                         // and survives a restart
});

// ---------------------------------------------------------------- the generated clip preempts the planned one
const withPlanned = (extra = {}) => ({ playlist: [track('A', 'One'), track('', 'evergreen-time-1', { Path: 'C:\\GLR\\evergreen-time-1.mp3' }), track('C', 'Three')], ...extra });

test('replace: the generated clip takes the planned clip\'s place, and the swap is verified', async () => {
  const t = await boot({ insertArg: '{path}|{position}|{replace}' }, withPlanned());
  const clip = (await ingest(t, 1)).json.clip;
  const r = await t.call('POST', '/queue/insert', { clip: clip.id, replace: 'evergreen-time-1' });
  assert.deepStrictEqual([r.status, r.json.inserted, r.json.position, r.json.replaced, r.json.verified], [200, true, 2, true, true]);   // the planned clip was 2nd in line, so the clip goes in its place
  assert.ok(t.radiodj.commands()[0].arg.endsWith('|2|evergreen-time-1'));
  assert.ok(!t.radiodj.playlist.some((x) => x.Title === 'evergreen-time-1'));
  t.close();
});

test('replace: if the planned clip is not found, or is the immediately-next item, nothing is touched and the planned clip plays', async () => {
  let t = await boot({ insertArg: '{path}|{position}|{replace}' }, withPlanned());
  let clip = (await ingest(t, 1)).json.clip;
  const gone = await t.call('POST', '/queue/insert', { clip: clip.id, replace: 'some-other-clip' });
  assert.deepStrictEqual([gone.status, gone.json.reason], [409, 'planned-clip-not-found']);
  assert.strictEqual(t.radiodj.commands().length, 0);
  t.close();
  t = await boot({ insertArg: '{path}|{position}|{replace}' }, { playlist: [track('', 'evergreen-time-1', { Path: 'evergreen-time-1.mp3' }), track('B', 'Two')] });
  clip = (await ingest(t, 2)).json.clip;
  const next = await t.call('POST', '/queue/insert', { clip: clip.id, replace: 'evergreen-time-1' });
  assert.deepStrictEqual([next.status, next.json.reason], [409, 'planned-clip-is-next']);
  assert.strictEqual(t.radiodj.commands().length, 0);
  t.close();
});

test('replace: if the planned clip is still queued after the insert, that is reported as replaced:false (both would air)', async () => {
  const t = await boot({ insertArg: '{path}|{position}|{replace}' }, withPlanned({ removeReplaced: false }));
  const clip = (await ingest(t, 1)).json.clip;
  const r = await t.call('POST', '/queue/insert', { clip: clip.id, replace: 'evergreen-time-1' });
  assert.deepStrictEqual([r.status, r.json.inserted, r.json.replaced], [200, true, false]);
  t.close();
});

test('replace in shadow mode only says what it would replace', async () => {
  const t = await boot({ shadow: true, insertArg: '{path}|{position}|{replace}' }, withPlanned());
  const clip = (await ingest(t, 1)).json.clip;
  const r = await t.call('POST', '/queue/insert', { clip: clip.id, replace: 'evergreen-time-1' });
  assert.deepStrictEqual([r.status, r.json.shadow, r.json.wouldReplace, r.json.position], [202, true, 'evergreen-time-1', 2]);
  assert.strictEqual(t.radiodj.commands().length, 0);
  t.close();
});

test('a dynamic slot with no leadSeconds leads by 300 s plus the preceding item duration, or 300 s with no preceding item', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lead-'));
  fs.writeFileSync(path.join(dir, 'GLR 2026-10-22.json'), JSON.stringify({ name: 'GLR 2026-10-22', items: [
    { time: '19:00:00', kind: 'song', artist: 'A', title: 'B', durationSeconds: 200 },
    { time: '19:04:00', kind: 'dynamic-slot', dynamic: { slotKind: 'time-check', fallbackClipId: 'evergreen-time-1' } },
    { time: '19:05:00', kind: 'dynamic-slot', dynamic: { slotKind: 'weather', leadSeconds: 90 } },
    { time: '19:06:00', kind: 'dynamic-slot', dynamic: { slotKind: 'promo' } },
  ] }));
  const t = await boot({ scheduleDir: dir, now: () => Date.parse('2026-10-23T05:30:00Z') });
  const day = (await t.call('GET', '/schedule', undefined, 'read-a')).json;
  assert.strictEqual(day.items[1].dynamic.leadSeconds, 500);
  assert.strictEqual(day.items[2].dynamic.leadSeconds, 90);
  assert.strictEqual(day.items[3].dynamic.leadSeconds, 300);
  assert.strictEqual(day.items[1].dynamic.precedingSeconds, 200);       // the swap deadline is the start of the item before
  assert.strictEqual(day.items[3].dynamic.precedingSeconds, undefined); // no preceding duration, so the hub keeps the old rule
  t.close();
});
