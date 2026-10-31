// The outbound side, for a PC that cannot accept inbound connections (home NAT). Every few seconds this:
//   1. reads the local agent's /agent/status and sends it to the hub as a heartbeat (so the hub shows the station online, now playing, mode)
//   2. once a day (and when the plan changes) sends the dynamic slots of today and tomorrow from the local /schedule
//   3. asks the hub for finished clips (GET /stations/:id/queue), downloads each, checks its sha256,
//      hands it to the LOCAL agent (POST /ingest, POST /queue/insert) so every local safety check applies (kill switch, live-show, shadow,
//      allowlist, "2 items ahead"), and reports the outcome to the hub (POST .../ack)
// Anything that goes wrong is reported and skipped: the planned (evergreen) content simply plays. Nothing is retried past a clip's expiry.
const crypto = require('crypto');

function createPuller({ hubUrl, stationId, key, localUrl, localKey, intervalMs = 15000, fetchImpl = globalThis.fetch, now = Date.now, log = (m) => console.error(m), timeoutMs = 20000 }) {
  if (!hubUrl || !stationId || !key) throw new Error('HUB_URL, HUB_STATION_ID and HUB_STATION_KEY are all needed to pull from a hub');
  const hub = (p) => new URL(`/stations/${encodeURIComponent(stationId)}${p}`, hubUrl.endsWith('/') ? hubUrl : `${hubUrl}/`);
  const local = (p) => new URL(p, localUrl.endsWith('/') ? localUrl : `${localUrl}/`);
  const hubHeaders = (extra = {}) => ({ 'x-api-key': key, ...extra });
  const localHeaders = (extra = {}) => ({ 'x-api-key': localKey, ...extra });
  const state = { slotsHash: '', timer: null, busy: false, lastError: '' };

  async function json(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (err) { /* not JSON */ }
    return { status: res.status, ok: res.ok, body };
  }

  async function heartbeat() {
    const st = await json(local('/agent/status'), { headers: localHeaders() });
    if (!st.ok) throw new Error(`the local agent answered ${st.status}`);
    const r = await json(hub('/heartbeat'), { method: 'POST', headers: hubHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ status: st.body }) });
    if (!r.ok) throw new Error(`the hub answered ${r.status} to the heartbeat${r.body && r.body.error ? `: ${r.body.error}` : ''}`);
    return st.body;
  }

  async function syncSlots(broadcastTz) {
    const dates = [];
    const t = now();
    for (const add of [0, 1]) dates.push(new Date(t + add * 86400e3).toLocaleDateString('en-CA', { timeZone: broadcastTz || 'UTC' }));
    const slots = [];
    for (const date of dates) {
      const day = await json(local(`/schedule?date=${date}`), { headers: localHeaders() });
      if (!day.ok || !day.body || !day.body.available) continue;
      for (const i of day.body.items) {
        if (i.kind !== 'dynamic-slot' || !i.startsAt || !i.dynamic) continue;
        slots.push({ kind: i.dynamic.slotKind, startsAt: i.startsAt, leadSeconds: i.dynamic.leadSeconds, precedingSeconds: i.dynamic.precedingSeconds, personaId: i.dynamic.personaId, fallbackClipId: i.dynamic.fallbackClipId, constraints: i.dynamic.constraints || {}, ref: `${date}#${i.index}` });
      }
    }
    const hash = crypto.createHash('sha1').update(JSON.stringify(slots)).digest('hex');
    if (hash === state.slotsHash) return 0;
    const r = await json(hub('/slots'), { method: 'PUT', headers: hubHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ source: 'schedule', slots }) });
    if (r.ok) state.slotsHash = hash;
    return r.ok ? slots.length : 0;
  }

  async function ack(item, body) {
    await json(hub(`/queue/${encodeURIComponent(item.id)}/ack`), { method: 'POST', headers: hubHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }).catch(() => {});
  }

  async function handle(item) {
    if (item.expiresAt && Date.parse(item.expiresAt) <= now()) return ack(item, { status: 'skipped', reason: 'expired before it was picked up' });
    let audio;
    try {
      const res = await fetchImpl(hub(`/queue/${encodeURIComponent(item.id)}/audio`), { headers: hubHeaders(), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return ack(item, { status: 'failed', reason: `could not download the audio (${res.status})` });
      audio = Buffer.from(await res.arrayBuffer());
    } catch (err) { return ack(item, { status: 'failed', reason: `could not download the audio: ${err.message}` }); }
    const sha = crypto.createHash('sha256').update(audio).digest('hex');
    if (item.sha256 && sha !== item.sha256) return ack(item, { status: 'failed', reason: 'the downloaded audio does not match its sha256' });
    try {
      const q = new URLSearchParams({ generated: '1', play: '0', title: item.title || item.kind || 'dynamic', sha256: sha });
      const ing = await json(local(`/ingest?${q}`), { method: 'POST', headers: localHeaders({ 'content-type': item.mime || 'audio/mpeg' }), body: audio });
      if (!ing.ok && ing.status !== 202) return ack(item, { status: ing.status === 423 || ing.status === 409 ? 'skipped' : 'failed', reason: (ing.body && ing.body.error) || `ingest answered ${ing.status}` });
      const ins = await json(local('/queue/insert'), { method: 'POST', headers: localHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ clip: ing.body.clip.id, sha256: sha, ahead: item.ahead || 2, ...(item.replace ? { replace: item.replace } : {}) }) });
      if (ins.status === 202 && ins.body && ins.body.shadow) return ack(item, { status: 'shadow', reason: 'the local agent is in shadow mode: nothing was inserted' });
      if (!ins.ok) return ack(item, { status: ins.status === 423 || ins.status === 409 ? 'skipped' : 'failed', reason: (ins.body && ins.body.error) || `insert answered ${ins.status}` });
      // Both the generated and the planned clip queued would air twice: that is reported as a failure, not a success.
      if (ins.body.replaced === false) return ack(item, { status: 'failed', reason: 'inserted, but the planned clip was not removed: both may play. Check the queue.' });
      return ack(item, { status: 'inserted', position: ins.body.position, verified: ins.body.verified, replaced: ins.body.replaced, duplicate: !!ins.body.duplicate });
    } catch (err) { return ack(item, { status: 'failed', reason: err.message }); }
  }

  async function tick() {
    if (state.busy) return { skipped: true };
    state.busy = true;
    try {
      const st = await heartbeat();
      await syncSlots(st.broadcastTz).catch(() => 0);
      const q = await json(hub('/queue'), { headers: hubHeaders() });
      if (!q.ok) throw new Error(`the hub answered ${q.status} to the queue request`);
      if (q.body && q.body.killed) return { killed: true, handled: 0 };
      let handled = 0;
      for (const item of (q.body && q.body.items) || []) { await handle(item); handled += 1; }
      state.lastError = '';
      return { handled };
    } catch (err) {
      if (err.message !== state.lastError) log(`hub pull: ${err.message}`);
      state.lastError = err.message;
      return { error: err.message };
    } finally { state.busy = false; }
  }

  function start() { if (!state.timer) { state.timer = setInterval(tick, intervalMs); if (state.timer.unref) state.timer.unref(); tick(); } }
  function stop() { if (state.timer) clearInterval(state.timer); state.timer = null; }
  return { tick, start, stop, state };
}

module.exports = { createPuller };
