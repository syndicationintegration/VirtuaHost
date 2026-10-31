// Just-in-time (JIT) drops: a line is written and spoken a few minutes before it airs, instead of being baked the night before.
// The planned ("evergreen") clip stays in the nightly playlist and is what plays whenever anything here does not finish: every error,
// timeout, cap, refusal or missing audio ends in a recorded reason and NO queue entry. That is "failing open".
//
//   dynamic slot  { id, stationId, kind, startsAt, leadSeconds, personaId, fallbackClipId, constraints }
//   worker tick   for each slot inside its lead window:
//     1. write the text with the site (/api/generate, textOnly) and use `filledIn`, never `scriptText`/`raw`
//     2. validate it (length, blocklist, language policy, no invented names/numbers/contacts, placeholders resolved) BEFORE spending on speech
//     3. check the daily cap, then speak it (preview: true, nothing is saved in the site library); cached by content hash so a line that is
//        the same for several stations is spoken once
//     4. shadow mode (the default): store what WOULD have aired and queue nothing. Live: wait for approval (default), then queue it for the
//        station to PULL (GET /stations/:id/queue); the station inserts it locally and acks.
//   kill switches (global and per station), per-day caps, a circuit breaker per provider, and retries with backoff guard the whole thing.
const crypto = require('crypto');
const tz = require('./tz');
const { HubError } = require('./errors');
const { validateText } = require('./validate');
const { classify } = require('./freshness');

const KINDS = ['time-check', 'weather', 'event-reminder', 'host-break', 'station-id', 'promo'];
const FINAL = new Set(['shadow', 'queued', 'inserted', 'fallback', 'suppressed', 'rejected']);
const MAX_ITEMS = 600;
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const id = (n = 6) => crypto.randomBytes(n).toString('hex');
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v, count, max) => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, count) : []);

const DEFAULT_SETTINGS = {
  kill: { on: false }, forceShadow: false, dailyCharCap: 6000, globalDailyCharCap: null, blocklist: [], languagePolicy: 'clean', personaPolicies: {},
  costPer1kCharsUsd: null, costPer1kTextTokensUsd: null, safetyMarginSeconds: 60, minAudioBytes: 1500, breakerThreshold: 3, breakerCooldownSeconds: 300, tries: 3,
  alerts: { enabled: false },
};

// "tonight at 7 PM", "tomorrow at 7 PM", "Saturday, Oct 24 at 7 PM": an event's start in the STATION's clock (never the PC's), relative to now.
function whenPhrase(eventMs, nowMs, zone) {
  const days = (ms) => { const d = tz.dateIn(ms, zone).split('-').map(Number); return Math.round(Date.UTC(d[0], d[1] - 1, d[2]) / 86400e3); };
  const diff = days(eventMs) - days(nowMs);
  const p = tz.parts(eventMs, zone);
  const clock = `${p.hour % 12 === 0 ? 12 : p.hour % 12}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''} ${p.hour < 12 ? 'AM' : 'PM'}`;
  if (diff === 0) return `${p.hour >= 17 ? 'tonight' : 'today'} at ${clock}`;
  if (diff === 1) return `tomorrow at ${clock}`;
  const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(eventMs));
  return `${label} at ${clock}`;
}

function createJit({ store, audio, now = Date.now, fetchImpl = globalThis.fetch, siteUrl = '', siteKey = '', generate = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stations, audit = () => {} }) {
  const J = () => {
    if (!store.data.jit) store.data.jit = { settings: {}, slots: [], items: [], queue: [], clips: {}, texts: {}, usage: {}, breakers: {} };
    const j = store.data.jit;
    j.settings = { ...DEFAULT_SETTINGS, ...j.settings, kill: { ...DEFAULT_SETTINGS.kill, ...(j.settings && j.settings.kill) }, alerts: { ...DEFAULT_SETTINGS.alerts, ...(j.settings && j.settings.alerts) } };
    return j;
  };
  const settings = () => J().settings;
  const jitOf = (s) => ({ enabled: false, shadow: true, requireApproval: true, kill: false, dailyCharCap: null, ...(s && s.jit) });
  const zoneOf = (s) => (s && s.broadcastTz) || 'UTC';
  const find = (sid) => stations.find(sid);

  // ---------- slots ----------
  function parseWhen(v, zone) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string' || !v.trim()) throw new HubError('startsAt is required (an ISO time with its offset, or a local time in the station\'s broadcast zone)');
    const t = v.trim();
    if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(t)) { const ms = Date.parse(t); if (Number.isFinite(ms)) return ms; }
    const ms = tz.parseMachineTimestamp(t.length === 16 ? `${t}:00` : t, zone);          // a local time with no offset: in the BROADCAST zone
    if (ms === null) throw new HubError(`startsAt "${t.slice(0, 40)}" is not a time (use 2026-10-22T19:00 or 2026-10-22T19:00:00-06:00)`);
    return ms;
  }
  function cleanConstraints(c) {
    const r = c && typeof c === 'object' ? c : {};
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v)) : undefined);
    const names = (Array.isArray(r.names) ? r.names : []).slice(0, 20).map((n) => (n && typeof n === 'object' ? { artist: text(n.artist, 80), title: text(n.title, 120) } : text(n, 120))).filter((n) => (typeof n === 'string' ? n : n.artist || n.title));
    const ev = r.event && typeof r.event === 'object' ? r.event : null;
    const event = ev && text(ev.name, 120) ? { name: text(ev.name, 120), ...(ev.startsAt ? { startsAt: ev.startsAt } : {}), ...(text(ev.venue, 120) ? { venue: text(ev.venue, 120) } : {}) } : undefined;
    return {
      ...(num(r.maxChars, 40, 1000) ? { maxChars: num(r.maxChars, 40, 1000) } : {}), ...(num(r.maxSeconds, 3, 90) ? { maxSeconds: num(r.maxSeconds, 3, 90) } : {}),
      ...(['clean', 'explicit-ok'].includes(r.languagePolicy) ? { languagePolicy: r.languagePolicy } : {}), blocklist: list(r.blocklist, 50, 40), names, facts: list(r.facts, 20, 200), allow: list(r.allow, 20, 120),
      ...(event ? { event } : {}), ...(text(r.prompt, 400) ? { prompt: text(r.prompt, 400) } : {}), ...(text(r.voice, 60) ? { voice: text(r.voice, 60) } : {}), ...(text(r.speechModel, 100) ? { speechModel: text(r.speechModel, 100) } : {}),
    };
  }
  function cleanSlot(input, existing) {
    const stationId = input.stationId !== undefined ? input.stationId : existing && existing.stationId;
    const station = find(stationId);
    if (!station) throw new HubError(`no station "${String(stationId).slice(0, 40)}"`, 404);
    const kind = input.kind !== undefined ? input.kind : existing && existing.kind;
    if (!KINDS.includes(kind)) throw new HubError(`kind must be one of: ${KINDS.join(', ')}`);
    if (!station.broadcastTz && !(typeof (input.startsAt ?? (existing && existing.startsAt)) === 'string' && /([zZ]|[+-]\d{2}:?\d{2})$/.test(String(input.startsAt)))) throw new HubError(`${station.name} has no broadcastTz: set it before giving local times`);
    const lead = Number(input.leadSeconds !== undefined ? input.leadSeconds : existing ? existing.leadSeconds : 300);
    if (!Number.isFinite(lead) || lead < 60 || lead > 3600) throw new HubError('leadSeconds must be between 60 and 3600');
    const startsAt = input.startsAt !== undefined ? parseWhen(input.startsAt, zoneOf(station)) : existing.startsAt;
    const constraints = cleanConstraints(input.constraints !== undefined ? input.constraints : existing && existing.constraints);
    if (constraints.event && constraints.event.startsAt !== undefined) constraints.event.startsAt = parseWhen(constraints.event.startsAt, zoneOf(station));
    const rawScript = input.script !== undefined ? input.script : existing && existing.script;      // null clears it
    const script = rawScript && rawScript.id ? { id: text(rawScript.id, 60), mode: rawScript.mode === 'draft' ? 'draft' : 'fixed' } : undefined;
    if (script && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(script.id)) throw new HubError('script.id is a saved script id from the site (lowercase letters, numbers, dashes)');
    if (kind === 'event-reminder' && !constraints.event) throw new HubError('an event-reminder slot needs constraints.event { name, startsAt }');
    return {
      id: existing ? existing.id : id(5), stationId: station.id, kind, startsAt, leadSeconds: Math.round(lead),
      ...(input.precedingSeconds !== undefined || (existing && existing.precedingSeconds !== undefined) ? { precedingSeconds: Math.round(Math.min(3600, Math.max(0, Number(input.precedingSeconds !== undefined ? input.precedingSeconds : existing.precedingSeconds) || 0))) } : {}),
      personaId: text(input.personaId !== undefined ? input.personaId : existing && existing.personaId, 80), fallbackClipId: text(input.fallbackClipId !== undefined ? input.fallbackClipId : existing && existing.fallbackClipId, 120),
      ...(script ? { script } : {}), constraints, songNeutral: input.songNeutral !== undefined ? input.songNeutral === true : !!(existing && existing.songNeutral), enabled: input.enabled !== undefined ? input.enabled !== false : existing ? existing.enabled !== false : true,
      source: existing ? existing.source : text(input.source, 20) === 'schedule' ? 'schedule' : 'manual', ref: existing ? existing.ref : text(input.ref, 80), createdAt: existing ? existing.createdAt : now(),
    };
  }
  const slotView = (s) => {
    const st = find(s.stationId); const it = J().items.find((i) => i.slotId === s.id);
    const filled = it && it.text && typeof it.text.filledIn === 'string' ? it.text.filledIn : '';
    const fr = it && it.freshness ? it.freshness : (filled ? classify(filled) : null);
    const songAudit = !!(s.songNeutral && fr && fr.reasons.some((r) => r.startsWith('song/track reference:')));      // a baked line that names a song on a song-neutral slot
    return { ...s, startsAtIso: tz.formatIso(s.startsAt, zoneOf(st)), item: itemView(it, false) || null, ...(fr ? { freshness: fr.freshness, freshnessReasons: fr.reasons } : {}), ...(songAudit ? { songNeutralAudit: 'fail' } : {}) };
  };
  function addSlot(input) { const slot = cleanSlot(input); J().slots.push(slot); store.save(); audit({ who: input.__who, action: 'slot.create', target: slot.id, result: 'ok' }); return slotView(slot); }
  function updateSlot(slotId, input) {
    const j = J(); const i = j.slots.findIndex((s) => s.id === slotId);
    if (i < 0) throw new HubError('no such slot', 404);
    j.slots[i] = cleanSlot(input, j.slots[i]); store.save();
    return slotView(j.slots[i]);
  }
  function removeSlot(slotId) {
    const j = J(); const before = j.slots.length;
    j.slots = j.slots.filter((s) => s.id !== slotId);
    if (j.slots.length === before) throw new HubError('no such slot', 404);
    store.save();
  }
  // The nightly builder's slots, pushed by the station (PUT /stations/:id/slots): added or updated by `ref`; future schedule slots that
  // vanished from the plan are dropped; anything that already has an item is left alone.
  function syncSlots(stationId, incoming) {
    const j = J(); const station = find(stationId);
    if (!station) throw new HubError('no such station', 404);
    const seen = new Set(); let added = 0; let updated = 0; let skipped = 0;
    for (const raw of (Array.isArray(incoming) ? incoming : []).slice(0, 500)) {
      try {
        const ref = text(raw.ref, 80);
        if (!ref) { skipped += 1; continue; }
        seen.add(ref);
        const cur = j.slots.find((s) => s.stationId === stationId && s.source === 'schedule' && s.ref === ref);
        if (cur && j.items.some((i) => i.slotId === cur.id)) continue;
        const slot = cleanSlot({ ...raw, stationId, source: 'schedule', ref }, cur);
        if (cur) { Object.assign(cur, slot); updated += 1; } else { j.slots.push(slot); added += 1; }
      } catch (err) { skipped += 1; }
    }
    const t = now();
    const before = j.slots.length;
    j.slots = j.slots.filter((s) => !(s.stationId === stationId && s.source === 'schedule' && !seen.has(s.ref) && s.startsAt > t && !j.items.some((i) => i.slotId === s.id)));
    store.save();
    return { added, updated, skipped, removed: before - j.slots.length };
  }

  // ---------- prompts ----------
  function buildPrompt(slot, station, atMs) {
    const c = slot.constraints || {};
    const given = [];
    for (const n of c.names || []) given.push(typeof n === 'string' ? n : [n.artist, n.title].filter(Boolean).join(' - '));
    const facts = [...(c.facts || [])];
    let when = '';
    if (c.event) when = c.event.startsAt ? whenPhrase(c.event.startsAt, atMs, zoneOf(station)) : '';
    const base = {
      'time-check': 'Give a very short time check for listeners. Say the time using {{time}}.',
      weather: 'Give a very short weather mention using {{weather}} and {{temp}}.',
      'event-reminder': c.event ? `Remind listeners about the event "${c.event.name}"${when ? ` happening ${when}` : ''}${c.event.venue ? ` at ${c.event.venue}` : ''}.` : 'Remind listeners about an upcoming event.',
      'host-break': given.length ? `Introduce what is coming up next, naming only: ${given.join('; ')}.` : 'Give a short friendly host break that introduces no songs by name.',
      'station-id': 'Say a short station identification for {{station}}.',
      promo: 'Give a short promo for the station.',
    }[slot.kind];
    const lines = [c.prompt ? `${base} ${c.prompt}` : base];
    if (facts.length) lines.push(`Facts you may use: ${facts.join('; ')}.`);
    lines.push('Use only the facts and names listed above. Do not mention any song, artist, event, place, number, address, phone number or website that is not listed.');
    return { prompt: lines.join(' '), whenPhrase: when };
  }

  // ---------- providers: retries, breakers, the site ----------
  const breaker = (name) => { const b = J().breakers; if (!b[name]) b[name] = { fails: 0, openUntil: 0, lastError: '' }; return b[name]; };
  function breakerCheck(name) {
    const b = breaker(name);
    if (b.openUntil > now()) throw Object.assign(new Error(`the ${name} provider keeps failing; paused until ${new Date(b.openUntil).toISOString()} (${b.lastError})`), { code: 'circuit-open', provider: name });
  }
  function breakerResult(name, ok, error) {
    const b = breaker(name);
    if (ok) { b.fails = 0; b.openUntil = 0; return; }
    b.fails += 1; b.lastError = String(error || 'failed').slice(0, 160);
    if (b.fails >= settings().breakerThreshold) { b.openUntil = now() + settings().breakerCooldownSeconds * 1000; audit({ who: 'jit', action: 'breaker.open', target: name, result: 'open', detail: b.lastError }); }
  }
  const transient = (r) => r.status === 0 || r.status >= 500 || r.status === 429 || r.status === 408;
  async function siteCall(body, timeoutMs = 45000, apiPath = '/api/generate') {
    if (generate) return generate(body, apiPath);
    if (!siteUrl || !siteKey) throw new HubError('set SITE_URL and SITE_KEY (a scoped service key) so the hub can write and speak lines', 503);
    try {
      const res = await fetchImpl(new URL(apiPath, siteUrl), { method: 'POST', headers: { 'x-api-key': siteKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const raw = await res.text(); let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch (err) { /* not JSON */ }
      return { status: res.status, json };
    } catch (err) { return { status: 0, json: { error: err.name === 'TimeoutError' ? 'timed out' : err.message } }; }
  }
  // Calls the site with retry + backoff for transient errors, inside the time left before `deadline`.
  async function provider(name, body, deadline, apiPath) {
    breakerCheck(name);
    let last;
    const tries = settings().tries;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (now() >= deadline) { last = { status: 0, json: { error: 'ran out of time before the slot' } }; break; }
      last = await siteCall(body, 45000, apiPath);
      if (last.status >= 200 && last.status < 300) { breakerResult(name, true); return last; }
      if (!transient(last)) break;
      if (attempt < tries - 1) await sleep(Math.min(2000 * 2 ** attempt, Math.max(0, deadline - now() - 1000)));
    }
    const msg = (last.json && last.json.error) || `the site answered ${last.status}`;
    breakerResult(name, false, msg);
    throw Object.assign(new Error(msg), { code: last.status === 0 ? 'unreachable' : 'provider-error', provider: name, status: last.status });
  }

  // ---------- usage, caps, estimates ----------
  const usageDay = (st) => tz.dateIn(now(), zoneOf(st));
  function usageFor(st) {
    const u = J().usage; const day = usageDay(st);
    if (!u[st.id] || u[st.id].day !== day) u[st.id] = { day, chars: 0, requests: 0, texts: 0 };
    return u[st.id];
  }
  const globalUsed = () => Object.values(J().usage).reduce((a, u) => a + (u.chars || 0), 0);
  function capFor(st) { const v = jitOf(st).dailyCharCap; return Number.isFinite(v) && v >= 0 ? v : settings().dailyCharCap; }
  function capCheck(st, chars) {
    const used = usageFor(st); const cap = capFor(st); const g = settings().globalDailyCharCap;
    if (cap !== null && used.chars + chars > cap) return `daily character cap for ${st.name} (${used.chars} used of ${cap}, this line needs ${chars})`;
    if (Number.isFinite(g) && g !== null && globalUsed() + chars > g) return `global daily character cap (${globalUsed()} used of ${g})`;
    return '';
  }
  function estimate({ stationId, chars, slot }) {
    const st = find(stationId || (slot && slot.stationId));
    if (!st) throw new HubError('no such station', 404);
    const s = settings(); const max = (slot && slot.constraints && slot.constraints.maxChars) || 400;
    const n = Number.isFinite(chars) ? chars : max;
    const textTokens = Math.round(((slot ? 600 : 400) + n) / 4);
    const tts = s.costPer1kCharsUsd === null ? null : (n / 1000) * s.costPer1kCharsUsd;
    const wr = s.costPer1kTextTokensUsd === null ? null : (textTokens / 1000) * s.costPer1kTextTokensUsd;
    const used = usageFor(st); const cap = capFor(st);
    return {
      chars: n, ceilingChars: max, likelyChars: Math.round(Math.min(n, max) * 0.55), seconds: Math.round(n / 15), credits: n, textTokensApprox: textTokens,
      usd: tts === null && wr === null ? null : { tts, text: wr, total: (tts || 0) + (wr || 0) }, note: tts === null ? 'Set costPer1kCharsUsd in the JIT settings to see dollars; credits are about one per character.' : '',
      cap: { day: used.day, used: used.chars, cap, remaining: cap === null ? null : Math.max(0, cap - used.chars), wouldExceed: cap !== null && used.chars + n > cap },
    };
  }

  // ---------- audio ----------
  function sniff(buf) {
    if (buf.length > 3 && buf.slice(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
    if (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
    if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
    return '';
  }
  const contentKey = (txt, slotLike) => sha256(JSON.stringify([txt, slotLike.script ? slotLike.script.id : '', slotLike.personaId || '', (slotLike.constraints && slotLike.constraints.voice) || '', (slotLike.constraints && slotLike.constraints.speechModel) || '']));

  // ---------- items ----------
  const itemView = (i, withLog = true) => (i ? {
    id: i.id, slotId: i.slotId, broadcastId: i.broadcastId, stationId: i.stationId, kind: i.kind, startsAt: i.startsAt, state: i.state, reason: i.reason || '', shadow: !!i.shadow,
    fallbackClipId: i.fallbackClipId || '', personaId: i.personaId || '', text: i.text || null, textModel: i.textModel || '', chars: i.chars || 0, estimate: i.estimate || null,
    audio: i.audioHash ? { sha256: i.audioHash, bytes: i.audioBytes, mime: i.mime, cacheHit: !!i.cacheHit } : null, validation: i.validation || null, approval: i.approval || { state: 'none' },
    queue: i.queueId ? { id: i.queueId, ...queueInfo(i.queueId) } : null, createdAt: i.createdAt, updatedAt: i.updatedAt, ...(withLog ? { log: i.log } : {}),
  } : null);
  const queueInfo = (qid) => { const q = J().queue.find((x) => x.id === qid); return q ? { state: q.state, ack: q.ack || null, expiresAt: q.expiresAt } : {}; };
  const touch = (item) => { item.updatedAt = now(); store.save(); };
  const log = (item, step, ok, detail = '') => { item.log.push({ at: now(), step, ok, detail: String(detail).slice(0, 300) }); if (item.log.length > 40) item.log.shift(); };
  function finish(item, state, reason) { item.state = state; item.reason = reason || ''; log(item, state, state !== 'fallback', reason); touch(item); return item; }
  function newItem(base) {
    const j = J();
    const item = { id: id(6), state: 'generating', reason: '', log: [], createdAt: now(), updatedAt: now(), approval: { state: 'none' }, ...base };
    j.items.push(item);
    if (j.items.length > MAX_ITEMS) j.items.splice(0, j.items.length - MAX_ITEMS);
    return item;
  }

  function enqueue(item, station, slotLike) {
    const j = J();
    const startsAt = item.startsAt;
    const q = { id: id(6), itemId: item.id, stationId: station.id, kind: item.kind, title: `${item.kind} ${tz.formatLocal(startsAt, zoneOf(station)).slice(11, 16)}`, text: item.text.filledIn, audioHash: item.audioHash, sha256: item.audioHash, bytes: item.audioBytes, mime: item.mime, startsAt,
      expiresAt: startsAt - 30000, ahead: 2, replace: slotLike.fallbackClipId || '', state: 'queued', createdAt: now() };
    j.queue.push(q);
    item.queueId = q.id; item.state = 'queued'; item.reason = ''; log(item, 'queued', true, `for ${station.name}`);
    touch(item);
    return q;
  }

  const namesList = (c) => (c.names || []).map((n) => (typeof n === 'string' ? n : [n.artist, n.title].filter(Boolean).join(' - '))).filter(Boolean);
  // A conversation is "Name: line" per line: what is checked (and counted) is the words, not the speaker labels.
  const spokenOf = (txt, isScript) => (isScript ? String(txt).split('\n').map((l) => l.replace(/^\s*[A-Za-z0-9][A-Za-z0-9 _.'-]{0,23}:\s*/, '')).join(' ') : txt);

  // ---------- the pipeline ----------
  async function runPipeline(slotLike, station, item, opts) {
    const s = settings(); const sj = jitOf(station);
    const margin = s.safetyMarginSeconds * 1000;
    // Swap deadline: the moment the item before the slot starts playing (the agent refuses a swap onto the immediately-next item).
    // Without a known preceding duration, it falls back to the old slot start minus the safety margin.
    const deadline = slotLike.precedingSeconds !== undefined ? slotLike.startsAt - slotLike.precedingSeconds * 1000 : slotLike.startsAt - margin;
    const atMs = slotLike.startsAt;
    const policy = (slotLike.constraints && slotLike.constraints.languagePolicy) || s.personaPolicies[slotLike.personaId] || s.languagePolicy;
    const { prompt, whenPhrase: when } = buildPrompt(slotLike, station, now());
    const textKey = sha256(JSON.stringify([slotLike.kind, slotLike.personaId, prompt, station.siteStationId || '', station.broadcastTz, station.city, station.lat, station.lon, Math.floor(atMs / 60000)]));
    const j = J();
    let written = j.texts[textKey] && now() - j.texts[textKey].at < 30 * 60000 ? j.texts[textKey] : null;
    const seconds = (slotLike.constraints && slotLike.constraints.maxSeconds) || (slotLike.kind === 'time-check' || slotLike.kind === 'station-id' ? 8 : 15);
    let attempt = 0; let verdict;
    const ctxFor = (w) => ({
      kind: slotLike.kind, maxChars: slotLike.constraints && slotLike.constraints.maxChars, maxSeconds: slotLike.constraints && slotLike.constraints.maxSeconds, languagePolicy: policy,
      blocklist: [...(s.blocklist || []), ...((slotLike.constraints && slotLike.constraints.blocklist) || [])], names: slotLike.constraints && slotLike.constraints.names, facts: slotLike.constraints && slotLike.constraints.facts,
      allow: slotLike.constraints && slotLike.constraints.allow, stationName: station.name, callsign: station.callsign, city: station.city, personaName: station.djName, whenPhrase: when,
      numbersMustBeGiven: ['host-break', 'promo', 'event-reminder'].includes(slotLike.kind), humanText: !!(slotLike.script && slotLike.script.mode === 'fixed'), site: w.site,
    });
    for (; attempt < 2; attempt += 1) {
      if (!written || attempt > 0) {
        const nudge = attempt > 0 ? ` (Your previous attempt was refused: ${verdict.problems.map((p) => p.code).join(', ')}. Write a different line that avoids this.)` : '';
        const t0 = now();
        let r;
        if (slotLike.script && slotLike.script.mode === 'draft') {
          // A saved script, written fresh by the AI from its cast and topic (every speaker in their own persona's voice).
          const c = slotLike.constraints || {};
          r = await provider('text', { scriptId: slotLike.script.id, ...(c.prompt || nudge ? { topic: `${c.prompt || ''}${nudge}`.trim() } : {}), seconds, ...(station.siteStationId ? { station: station.siteStationId } : {}), at: new Date(atMs).toISOString(), names: namesList(c), facts: c.facts || [], ...(policy === 'explicit-ok' ? { explicit: true } : {}) }, deadline, '/api/scripts/draft');
        } else if (slotLike.script) {
          r = await provider('text', { scriptId: slotLike.script.id, ...(station.siteStationId ? { station: station.siteStationId } : {}), at: new Date(atMs).toISOString() }, deadline, '/api/scripts/filled');
        } else {
          r = await provider('text', { mode: 'ai', prompt: prompt + nudge, textOnly: true, seconds, ...(slotLike.personaId ? { persona: slotLike.personaId } : {}), ...(station.siteStationId ? { station: station.siteStationId } : {}), at: new Date(atMs).toISOString(), ...(policy === 'explicit-ok' ? { explicit: true } : {}) }, deadline);
        }
        usageFor(station).texts += 1;
        const body = r.json || {};
        const filledIn = typeof body.filledIn === 'string' ? body.filledIn : '';                  // never scriptText: that may still carry {{placeholders}}
        written = { filledIn, raw: typeof body.raw === 'string' ? body.raw : '', textModel: body.textModel || '', site: { unresolvedPlaceholders: !!body.unresolvedPlaceholders, copiedExample: Array.isArray(body.copiedExample) ? body.copiedExample.length > 0 : !!body.copiedExample, templateMissing: body.templateMissing || [] }, at: now() };
        log(item, 'write', true, `${filledIn.length} chars in ${now() - t0} ms${body.textModel ? ` (${body.textModel})` : ''}`);
        if (!attempt) j.texts[textKey] = written;
      }
      verdict = validateText(spokenOf(written.filledIn, !!slotLike.script), ctxFor(written));
      if (verdict.ok && slotLike.songNeutral && classify(written.filledIn).reasons.some((r) => r.startsWith('song/track reference:')))
        verdict = { ok: false, problems: [{ code: 'song-on-neutral-slot', message: 'The line names a song, so a song-neutral slot cannot use it.' }] };
      item.text = { filledIn: written.filledIn, raw: written.raw }; item.freshness = { ...classify(written.filledIn), needsReview: false }; item.textModel = written.textModel; item.chars = written.filledIn.length; item.validation = verdict;
      item.estimate = estimate({ stationId: station.id, chars: item.chars, slot: slotLike });
      log(item, 'validate', verdict.ok, verdict.ok ? '' : verdict.problems.map((p) => p.code).join(', '));
      if (verdict.ok) break;
      delete j.texts[textKey];
    }
    if (!verdict.ok) return finish(item, 'fallback', `the line failed validation: ${verdict.problems.map((p) => p.message).join(' ')}`);
    if (now() >= deadline) return finish(item, 'fallback', 'ran out of time before the slot');

    // speak it, once per distinct content
    const ck = contentKey(written.filledIn, slotLike);
    let clip = j.clips[ck];
    if (clip && !audio.has(clip.audioHash)) clip = null;
    if (clip && clip.needsReview) clip = null;  // held until a person approves the line; never reused while held
    if (!clip) {
      const over = capCheck(station, item.chars);
      if (over) return finish(item, 'fallback', over);
      const speechBody = slotLike.script ? { mode: 'script', scriptId: slotLike.script.id, text: written.filledIn, preview: true, ...(station.siteStationId ? { station: station.siteStationId } : {}), at: new Date(atMs).toISOString() } : null;
      const r = await provider('speech', speechBody || { mode: 'say', text: written.filledIn, preview: true, ...(slotLike.personaId ? { persona: slotLike.personaId } : {}), ...(station.siteStationId ? { station: station.siteStationId } : {}), ...(slotLike.constraints && slotLike.constraints.speechModel ? { speechModel: slotLike.constraints.speechModel } : {}), ...(slotLike.constraints && slotLike.constraints.voice ? { voice: slotLike.constraints.voice } : {}) }, deadline);
      const b64 = r.json && r.json.audio;
      const buf = typeof b64 === 'string' && b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
      const mime = sniff(buf);
      if (!buf.length) return finish(item, 'fallback', 'the site returned no audio');
      if (buf.length < s.minAudioBytes) return finish(item, 'fallback', `the audio is only ${buf.length} bytes: too small to be speech`);
      if (!mime) return finish(item, 'fallback', 'the audio is not a recognised format (mp3, wav or ogg)');
      const hash = sha256(buf);
      audio.put(hash, buf, mime);
      clip = { audioHash: hash, bytes: buf.length, mime, chars: item.chars, createdAt: now(), uses: 0, speechModel: (r.json && r.json.speechModel) || '', freshness: item.freshness && item.freshness.freshness, needsReview: !!(item.freshness && item.freshness.needsReview) };
      j.clips[ck] = clip;
      const u = usageFor(station); u.chars += item.chars; u.requests += 1;
      item.cacheHit = false;
      log(item, 'speak', true, `${buf.length} bytes`);
    } else { item.cacheHit = true; log(item, 'speak', true, 'reused a clip made earlier (no new spend)'); }
    clip.uses += 1;
    Object.assign(item, { audioHash: clip.audioHash, audioBytes: clip.bytes, mime: clip.mime });
    if (now() >= deadline) return finish(item, 'fallback', 'ran out of time before the slot');

    const shadow = !!(opts.shadow || s.forceShadow || sj.shadow);
    item.shadow = shadow;
    if (shadow) { item.approval = { state: 'pending' }; return finish(item, 'shadow', 'shadow mode: this is what would have aired; nothing was queued'); }
    if (sj.requireApproval) { item.approval = { state: 'pending' }; item.state = 'awaiting-approval'; log(item, 'awaiting-approval', true); touch(item); return item; }
    item.approval = { state: 'approved', by: 'auto', at: now() };
    enqueue(item, station, slotLike);
    return item;
  }

  // One slot, start to finish. Never throws: whatever happens, the evergreen clip plays unless the line was queued.
  async function processSlot(slot, opts = {}) {
    const j = J(); const station = find(slot.stationId);
    if (!station) return null;
    const sj = jitOf(station); const s = settings();
    let item = j.items.find((i) => i.slotId === slot.id);
    if (item && FINAL.has(item.state) && !opts.again) return item;
    if (!item) item = newItem({ slotId: slot.id, stationId: station.id, kind: slot.kind, startsAt: slot.startsAt, fallbackClipId: slot.fallbackClipId, personaId: slot.personaId, shadow: sj.shadow });
    else { Object.assign(item, { state: 'generating', reason: '', log: [], approval: { state: 'none' } }); }
    try {
      if (s.kill.on) return finish(item, 'suppressed', `global kill switch is on${s.kill.reason ? ` (${s.kill.reason})` : ''}`);
      if (sj.kill) return finish(item, 'suppressed', 'this station\'s kill switch is on');
      if (!sj.enabled && !opts.force) return finish(item, 'suppressed', 'dynamic drops are switched off for this station');
      const run = stations.runtime(station.id);
      if (run && run.mode === 'live-show') return finish(item, 'suppressed', 'a live show is on air: dynamic slots are suppressed');
      if (now() >= slot.startsAt - s.safetyMarginSeconds * 1000) return finish(item, 'fallback', 'too late to prepare this slot');
      return await runPipeline(slot, station, item, opts);
    } catch (err) {
      return finish(item, 'fallback', err.code === 'circuit-open' ? err.message : `${err.provider ? `${err.provider}: ` : ''}${err.message}`);
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return { skipped: true };
    ticking = true;
    try {
      const j = J(); const t = now(); let worked = 0;
      sweepQueue();
      for (const slot of [...j.slots]) {
        if (slot.enabled === false) continue;
        if (t < slot.startsAt - slot.leadSeconds * 1000) continue;
        if (j.items.some((i) => i.slotId === slot.id)) continue;
        const station = find(slot.stationId);
        if (!station || !jitOf(station).enabled) continue;
        await processSlot(slot); worked += 1;
      }
      gc();
      return { worked };
    } finally { ticking = false; }
  }
  function sweepQueue() {
    const j = J(); const t = now();
    for (const q of j.queue) {
      if (q.state !== 'queued' || q.expiresAt > t) continue;
      q.state = 'expired';
      const item = j.items.find((i) => i.id === q.itemId);
      if (item && item.state === 'queued') finish(item, 'fallback', 'the station did not pick the clip up in time');
    }
  }
  let lastGc = 0;
  function gc() {
    if (now() - lastGc < 3600e3) return;
    lastGc = now();
    const j = J(); const cutoff = now() - 7 * 86400e3;
    j.queue = j.queue.filter((q) => q.createdAt > cutoff);
    for (const k of Object.keys(j.texts)) if (j.texts[k].at < now() - 3600e3) delete j.texts[k];
    const keep = new Set([...j.items.map((i) => i.audioHash), ...j.queue.map((q) => q.audioHash)].filter(Boolean));
    for (const [k, c] of Object.entries(j.clips)) if (!keep.has(c.audioHash) && c.createdAt < cutoff) { audio.remove(c.audioHash); delete j.clips[k]; }
    store.save();
  }

  // ---------- review: approve / reject ----------
  const who = (by) => ({ by: text(by && by.by, 60) || 'unknown', via: text(by && by.via, 20) || 'control', note: text(by && by.note, 300) });
  function findItem(itemId) { const it = J().items.find((i) => i.id === itemId); if (!it) throw new HubError('no such item', 404); return it; }
  // A person approves a clip that was held for review: it can be reused again.
  function clearClipReview(clipKey, by) {
    const clip = J().clips[clipKey];
    if (!clip) throw new HubError('no such clip', 404);
    clip.needsReview = false;
    audit({ who: who(by).by, action: 'clip.approve', target: clipKey, result: 'ok' });
    store.save();
    return { key: clipKey, needsReview: false };
  }

  function approve(itemId, by) {
    const item = findItem(itemId); const w = who(by);
    if (item.approval.state === 'rejected') throw new HubError('that item was rejected', 409);
    item.approval = { state: 'approved', ...w, at: now() };
    audit({ who: w.by, action: 'item.approve', target: itemId, result: 'ok', detail: item.shadow ? 'shadow review' : '' });
    if (item.state === 'awaiting-approval' && !item.shadow) {
      const station = find(item.stationId); const sj = jitOf(station); const s = settings();
      if (s.kill.on || sj.kill) finish(item, 'suppressed', 'a kill switch is on: approved, but nothing was queued');
      else if (now() >= item.startsAt - s.safetyMarginSeconds * 1000) finish(item, 'fallback', 'approved too late: the slot was too close');
      else enqueue(item, station, { fallbackClipId: item.fallbackClipId });
    } else touch(item);
    return itemView(item);
  }
  function reject(itemId, by) {
    const item = findItem(itemId); const w = who(by);
    item.approval = { state: 'rejected', ...w, at: now() };
    audit({ who: w.by, action: 'item.reject', target: itemId, result: 'ok', detail: w.note });
    for (const q of J().queue) if (q.itemId === item.id && q.state === 'queued') q.state = 'cancelled';
    if (!item.shadow || item.state === 'awaiting-approval') { item.state = 'rejected'; item.reason = w.note || 'rejected by a reviewer: the planned clip plays'; log(item, 'rejected', false, item.reason); }
    touch(item);
    return itemView(item);
  }

  // ---------- the station's side: pull ----------
  function queueFor(stationId) {
    const station = find(stationId); const s = settings(); const sj = jitOf(station);
    const run = stations.runtime(stationId) || {};
    const killed = s.kill.on || sj.kill;
    if (killed) return { killed: true, reason: s.kill.on ? s.kill.reason || 'global kill switch' : 'station kill switch', mode: run.mode || 'unknown', items: [] };
    if (run.mode === 'live-show') return { killed: false, mode: 'live-show', items: [], note: 'a live show is on air: nothing is handed out' };
    sweepQueue();
    const items = J().queue.filter((q) => q.stationId === stationId && q.state === 'queued' && q.expiresAt > now()).map((q) => ({ id: q.id, kind: q.kind, title: q.title, text: q.text, startsAt: q.startsAt, startsAtIso: tz.formatIso(q.startsAt, zoneOf(station)), expiresAt: new Date(q.expiresAt).toISOString(), ahead: q.ahead, replace: q.replace, sha256: q.sha256, bytes: q.bytes, mime: q.mime }));
    return { killed: false, mode: run.mode || 'unknown', items };
  }
  function audioFor(stationId, queueId) {
    const q = J().queue.find((x) => x.id === queueId && x.stationId === stationId);
    if (!q) throw new HubError('no such queue item', 404);
    const a = audio.get(q.audioHash);
    if (!a) throw new HubError('the audio is no longer stored', 410);
    return { buffer: a.buffer, mime: a.mime || q.mime, sha256: q.audioHash };
  }
  function ack(stationId, queueId, body) {
    const q = J().queue.find((x) => x.id === queueId && x.stationId === stationId);
    if (!q) throw new HubError('no such queue item', 404);
    const status = ['inserted', 'shadow', 'skipped', 'failed'].includes(body.status) ? body.status : null;
    if (!status) throw new HubError('status must be inserted, shadow, skipped or failed');
    q.state = status === 'inserted' ? 'inserted' : status; q.ack = { status, at: now(), position: Number.isFinite(body.position) ? body.position : undefined, verified: typeof body.verified === 'boolean' ? body.verified : null, replaced: typeof body.replaced === 'boolean' ? body.replaced : null, reason: text(body.reason, 300) };
    const item = J().items.find((i) => i.id === q.itemId);
    if (item) {
      if (status === 'inserted') finish(item, 'inserted', `inserted at position ${q.ack.position}${q.replace && q.ack.replaced === true ? `, replacing ${q.replace}` : ''}${q.ack.verified === false ? ' (could not be read back)' : ''}`);
      else if (status === 'shadow') finish(item, 'shadow', `the station is in shadow mode: ${q.ack.reason}`);
      else finish(item, 'fallback', `the station did not insert it (${status}): ${q.ack.reason || 'no reason given'}`);
    }
    audit({ who: `station:${stationId}`, action: 'queue.ack', target: queueId, result: status, detail: q.ack.reason });
    store.save();
    return { ok: true };
  }

  // ---------- one generation, many stations ----------
  // Writes (or takes) one line, speaks it once, and gives every chosen station the same audio. Stations that differ in anything the line can
  // depend on (zone, city, coordinates, name) get their own line; if those lines come out identical they still share the audio.
  async function broadcast(body) {
    const ids = body.stationIds === 'all' ? stations.list().map((x) => x.id) : Array.isArray(body.stationIds) ? body.stationIds : [];
    if (!ids.length) throw new HubError('choose stations: a list of ids, or "all"');
    const list2 = [...new Set(ids)].map((x) => find(x)).filter(Boolean);
    if (!list2.length) throw new HubError('no stations match', 404);
    const kind = KINDS.includes(body.kind) ? body.kind : 'promo';
    const startsAt = body.startsAt ? parseWhen(body.startsAt, zoneOf(list2[0])) : now() + 5 * 60000;
    const sig = (st) => sha256(JSON.stringify([st.broadcastTz, st.city, st.lat, st.lon, st.name, st.callsign, st.siteStationId]));
    const groups = new Map();
    for (const st of list2) { const k = sig(st); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(st); }
    const broadcastId = id(5); const results = []; const j = J();
    for (const members of groups.values()) {
      const lead = members[0];
      const slotLike = { kind, startsAt, personaId: text(body.personaId, 80), fallbackClipId: '', constraints: cleanConstraints({ ...body.constraints, prompt: body.prompt }) };
      if (body.text) { slotLike.constraints.facts = [...(slotLike.constraints.facts || [])]; }
      const item0 = newItem({ broadcastId, slotId: null, stationId: lead.id, kind, startsAt, personaId: slotLike.personaId, shadow: jitOf(lead).shadow });
      try {
        if (settings().kill.on || jitOf(lead).kill) { finish(item0, 'suppressed', 'a kill switch is on'); results.push({ stations: members.map((m) => m.id), item: itemView(item0) }); continue; }
        if (body.text) {
          const txt = text(body.text, 1000);
          const ctx = { kind, maxChars: slotLike.constraints.maxChars, languagePolicy: slotLike.constraints.languagePolicy || settings().languagePolicy, blocklist: [...settings().blocklist, ...(slotLike.constraints.blocklist || [])], humanText: true, stationName: lead.name, callsign: lead.callsign, city: lead.city };
          const v = validateText(txt, ctx);
          item0.text = { filledIn: txt, raw: txt }; item0.chars = txt.length; item0.validation = v; log(item0, 'validate', v.ok, v.problems.map((p) => p.code).join(', '));
          if (!v.ok) { finish(item0, 'fallback', `the line failed validation: ${v.problems.map((p) => p.message).join(' ')}`); results.push({ stations: members.map((m) => m.id), item: itemView(item0) }); continue; }
          const ck = contentKey(txt, slotLike);
          let clip = j.clips[ck]; if (clip && !audio.has(clip.audioHash)) clip = null;
          if (!clip) {
            const over = capCheck(lead, txt.length);
            if (over) { finish(item0, 'fallback', over); results.push({ stations: members.map((m) => m.id), item: itemView(item0) }); continue; }
            const r = await provider('speech', { mode: 'say', text: txt, preview: true, ...(slotLike.personaId ? { persona: slotLike.personaId } : {}), ...(lead.siteStationId ? { station: lead.siteStationId } : {}) }, startsAt);
            const buf = r.json && r.json.audio ? Buffer.from(r.json.audio, 'base64') : Buffer.alloc(0);
            const mime = sniff(buf);
            if (buf.length < settings().minAudioBytes || !mime) { finish(item0, 'fallback', 'the site returned no usable audio'); results.push({ stations: members.map((m) => m.id), item: itemView(item0) }); continue; }
            const hash = sha256(buf); audio.put(hash, buf, mime);
            clip = { audioHash: hash, bytes: buf.length, mime, chars: txt.length, createdAt: now(), uses: 0 }; j.clips[ck] = clip;
            const u = usageFor(lead); u.chars += txt.length; u.requests += 1;
          } else item0.cacheHit = true;
          Object.assign(item0, { audioHash: clip.audioHash, audioBytes: clip.bytes, mime: clip.mime });
        } else {
          // an AI-written line: one run of the pipeline for the lead station, shadow-forced so nothing is queued until the audio is shared out below
          const fake = { id: `b-${broadcastId}`, ...slotLike, stationId: lead.id };
          await runPipeline(fake, lead, item0, { shadow: true });
          if (item0.state !== 'shadow') { results.push({ stations: members.map((m) => m.id), item: itemView(item0) }); continue; }
        }
        // hand the same audio to every station in the group
        const made = [];
        for (const st of members) {
          const item = st.id === lead.id ? item0 : newItem({ broadcastId, slotId: null, stationId: st.id, kind, startsAt, personaId: slotLike.personaId, text: item0.text, textModel: item0.textModel, chars: item0.chars, audioHash: item0.audioHash, audioBytes: item0.audioBytes, mime: item0.mime, cacheHit: st.id !== lead.id || item0.cacheHit, validation: item0.validation });
          const sj = jitOf(st); const shadow = !!(body.shadow || settings().forceShadow || sj.shadow);
          item.shadow = shadow; item.cacheHit = st.id !== lead.id ? true : item0.cacheHit;
          if (!sj.enabled && !body.force) finish(item, 'suppressed', 'dynamic drops are switched off for this station');
          else if (settings().kill.on || sj.kill) finish(item, 'suppressed', 'a kill switch is on');
          else if (stations.runtime(st.id) && stations.runtime(st.id).mode === 'live-show') finish(item, 'suppressed', 'a live show is on air');
          else if (shadow) { item.approval = { state: 'pending' }; finish(item, 'shadow', 'shadow mode: this is what would have aired; nothing was queued'); } else if (sj.requireApproval) { item.approval = { state: 'pending' }; item.state = 'awaiting-approval'; log(item, 'awaiting-approval', true); touch(item); } else { item.approval = { state: 'approved', by: 'auto', at: now() }; enqueue(item, st, slotLike); }
          made.push(itemView(item, false));
        }
        results.push({ stations: members.map((m) => m.id), text: item0.text && item0.text.filledIn, audio: item0.audioHash, cacheHit: !!item0.cacheHit, items: made });
      } catch (err) {
        finish(item0, 'fallback', `${err.provider ? `${err.provider}: ` : ''}${err.message}`);
        results.push({ stations: members.map((m) => m.id), item: itemView(item0) });
      }
    }
    store.save();
    audit({ who: body.__who, action: 'broadcast', target: broadcastId, result: 'ok', detail: `${list2.length} stations, ${results.length} line(s)` });
    return { broadcastId, results };
  }

  // ---------- settings, kill, status ----------
  function updateSettings(patch, by) {
    const cur = settings(); const next = { ...cur };
    const num = (v, lo, hi) => (v === null ? null : Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined);
    if (patch.dailyCharCap !== undefined) { const v = num(patch.dailyCharCap, 0, 1e7); if (v === undefined) throw new HubError('dailyCharCap must be a number of characters'); next.dailyCharCap = v; }
    if (patch.globalDailyCharCap !== undefined) { const v = num(patch.globalDailyCharCap, 0, 1e8); if (v === undefined) throw new HubError('globalDailyCharCap must be a number of characters, or null'); next.globalDailyCharCap = v; }
    if (patch.costPer1kCharsUsd !== undefined) { const v = num(patch.costPer1kCharsUsd, 0, 100); if (v === undefined) throw new HubError('costPer1kCharsUsd must be a number'); next.costPer1kCharsUsd = v; }
    if (patch.costPer1kTextTokensUsd !== undefined) { const v = num(patch.costPer1kTextTokensUsd, 0, 100); if (v === undefined) throw new HubError('costPer1kTextTokensUsd must be a number'); next.costPer1kTextTokensUsd = v; }
    if (patch.blocklist !== undefined) next.blocklist = list(patch.blocklist, 200, 40);
    if (patch.languagePolicy !== undefined) { if (!['clean', 'explicit-ok'].includes(patch.languagePolicy)) throw new HubError('languagePolicy is clean or explicit-ok'); next.languagePolicy = patch.languagePolicy; }
    if (patch.personaPolicies && typeof patch.personaPolicies === 'object') next.personaPolicies = Object.fromEntries(Object.entries(patch.personaPolicies).filter(([, v]) => ['clean', 'explicit-ok'].includes(v)).slice(0, 100));
    if (patch.forceShadow !== undefined) next.forceShadow = patch.forceShadow === true;
    J().settings = next; store.save();
    audit({ who: by, action: 'jit.settings', target: 'global', result: 'ok', detail: Object.keys(patch).join(', ') });
    return settingsView();
  }
  function setKill({ on, reason, stationId }, by) {
    const w = text(by, 60) || 'unknown';
    if (stationId) {
      const st = find(stationId); if (!st) throw new HubError('no such station', 404);
      st.jit = { ...jitOf(st), kill: on === true, ...(on === true ? { killReason: text(reason, 200), killBy: w, killAt: now() } : {}) }; store.save();
    } else {
      J().settings.kill = on === true ? { on: true, reason: text(reason, 200), by: w, at: now() } : { on: false, by: w, at: now() }; store.save();
    }
    audit({ who: w, action: on === true ? 'kill.on' : 'kill.off', target: stationId || 'global', result: 'ok', detail: text(reason, 200) });
    return status();
  }
  function setStationJit(stationId, patch, by) {
    const st = find(stationId); if (!st) throw new HubError('no such station', 404);
    const cur = jitOf(st); const next = { ...cur };
    for (const k of ['enabled', 'shadow', 'requireApproval']) if (patch[k] !== undefined) next[k] = patch[k] === true;
    if (patch.dailyCharCap !== undefined) { if (patch.dailyCharCap === null) next.dailyCharCap = null; else if (Number.isFinite(Number(patch.dailyCharCap)) && Number(patch.dailyCharCap) >= 0) next.dailyCharCap = Number(patch.dailyCharCap); else throw new HubError('dailyCharCap must be a number of characters, or null'); }
    st.jit = next; store.save();
    audit({ who: by, action: 'station.jit', target: stationId, result: 'ok', detail: JSON.stringify(Object.fromEntries(Object.keys(patch).filter((k) => ['enabled', 'shadow', 'requireApproval', 'dailyCharCap'].includes(k)).map((k) => [k, patch[k]]))) });
    return jitView(st);
  }
  const settingsView = () => { const s = settings(); return { dailyCharCap: s.dailyCharCap, globalDailyCharCap: s.globalDailyCharCap, blocklist: s.blocklist, languagePolicy: s.languagePolicy, personaPolicies: s.personaPolicies, forceShadow: s.forceShadow, costPer1kCharsUsd: s.costPer1kCharsUsd, costPer1kTextTokensUsd: s.costPer1kTextTokensUsd, safetyMarginSeconds: s.safetyMarginSeconds, kill: s.kill }; };
  function jitView(st) {
    const sj = jitOf(st); const u = usageFor(st); const cap = capFor(st); const counts = {};
    for (const i of J().items.filter((x) => x.stationId === st.id)) counts[i.state] = (counts[i.state] || 0) + 1;
    return { stationId: st.id, enabled: sj.enabled, shadow: sj.shadow, requireApproval: sj.requireApproval, kill: sj.kill, dailyCharCap: sj.dailyCharCap, usage: { day: u.day, chars: u.chars, requests: u.requests, cap, remaining: cap === null ? null : Math.max(0, cap - u.chars) }, counts };
  }
  function status() {
    const b = J().breakers;
    return {
      settings: settingsView(), stations: stations.list().map(jitView),
      breakers: Object.fromEntries(['text', 'speech'].map((n) => [n, { fails: (b[n] || {}).fails || 0, open: ((b[n] || {}).openUntil || 0) > now(), openUntil: (b[n] || {}).openUntil || 0, lastError: (b[n] || {}).lastError || '' }])),
      globalUsedChars: globalUsed(), slots: J().slots.length, items: J().items.length, queued: J().queue.filter((q) => q.state === 'queued').length,
      alerts: alerts.status(), siteConfigured: !!(generate || (siteUrl && siteKey)),
    };
  }

  // Emergency alerts are NOT built. This is only the place they would plug in, and it refuses everything. When they are built they must:
  // use the official NWS text verbatim, be area-filtered, wait for human approval, honour the kill switch, and stay OFF by default.
  const alerts = {
    status: () => ({ enabled: false, planned: true, requires: ['official NWS text, verbatim', 'area filter', 'human approval', 'kill switch', 'off by default'] }),
    submit: () => ({ accepted: false, reason: 'Emergency alert broadcasting is planned, not built. Nothing was queued. The hub\'s weather-alert watches (alerts.js) are separate and are not EAS.' }),
  };

  function listItems({ state, stationId, limit = 100 } = {}) {
    return J().items.filter((i) => (!state || i.state === state || (state === 'review' && (i.state === 'shadow' || i.state === 'awaiting-approval')) ) && (!stationId || i.stationId === stationId)).slice(-Math.min(500, limit)).reverse().map((i) => itemView(i, false));
  }
  const getItem = (itemId) => itemView(findItem(itemId));
  function itemAudio(itemId) { const it = findItem(itemId); const a = it.audioHash && audio.get(it.audioHash); if (!a) throw new HubError('there is no audio for that item', 404); return { buffer: a.buffer, mime: a.mime || it.mime || 'audio/mpeg' }; }

  // Runs one slot now. Without `confirm` it spends nothing and returns the estimate; with it, the pipeline runs (shadow unless the station is live).
  async function runNow(slotId, { confirm = false, force = true, shadow = true } = {}) {
    const slot = J().slots.find((s) => s.id === slotId);
    if (!slot) throw new HubError('no such slot', 404);
    const est = estimate({ slot });
    if (!confirm) return { needsConfirm: true, estimate: est };
    const item = await processSlot(slot, { force, shadow, again: true });
    return { estimate: est, item: itemView(item) };
  }

  return { KINDS, tick, status, estimate, processSlot, clearClipReview, addSlot, updateSlot, removeSlot, syncSlots, listSlots: (stationId) => J().slots.filter((s) => !stationId || s.stationId === stationId).map(slotView), approve, reject, queueFor, audioFor, ack, broadcast, updateSettings, setKill, setStationJit, listItems, getItem, itemAudio, runNow, alerts, settings: settingsView, jitView, whenPhrase };
}

module.exports = { createJit, whenPhrase, KINDS };
