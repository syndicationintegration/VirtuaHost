// The day's schedule, read-only. The nightly playlist builder ("GLR YYYY-MM-DD", built 23:30 Denver, loaded 00:00:30 Denver) writes a plan
// file next to the playlist; this module reads it. It never touches RadioDJ's database.
//
//   <SCHEDULE_DIR>/GLR 2026-10-22.json      (any file starting "GLR 2026-10-22" and ending .json)
//   {
//     "name": "GLR 2026-10-22", "date": "2026-10-22", "tz": "America/Denver",
//     "items": [
//       { "startsAt": "2026-10-22T19:00:00-06:00",  or  "time": "19:00:00" (the station's clock),
//         "kind": "song|drop|interlude|segment|host-break|dynamic-slot",
//         "artist": "...", "title": "...", "durationSeconds": 215,
//         "dynamic": { "slotKind": "time-check|weather|event-reminder|host-break|station-id|promo", "personaId": "...", "leadSeconds": 300,
//                      "fallbackClipId": "evergreen-time-1", "constraints": { } } }       // only on kind "dynamic-slot"
//     ] }
//
// That file's shape is an interface agreed with the playlist builder (docs/INTEGRATION.md); nothing here has been run against the real builder.
const fs = require('fs');
const path = require('path');
const tz = require('./tz');

const KINDS = ['song', 'drop', 'interlude', 'segment', 'host-break', 'dynamic-slot'];
const SLOT_KINDS = ['time-check', 'weather', 'event-reminder', 'host-break', 'station-id', 'promo'];

function createSchedule({ dir = '', broadcastTz, now = Date.now }) {
  function file(date) {
    if (!dir) return null;
    let names;
    try { names = fs.readdirSync(dir); } catch (err) { return null; }
    const prefix = `GLR ${date}`;
    const hit = names.filter((n) => n.startsWith(prefix) && n.toLowerCase().endsWith('.json')).sort()[0];
    return hit ? path.join(dir, hit) : null;
  }

  function forDate(dateInput) {
    const date = dateInput || tz.dateIn(now(), broadcastTz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !tz.dayBounds(date, broadcastTz)) { const e = new Error('date must look like 2026-10-22'); e.status = 400; throw e; }
    const bounds = tz.dayBounds(date, broadcastTz);
    const base = { date, tz: broadcastTz, dayStart: tz.formatIso(bounds.start, broadcastTz), dayHours: bounds.hours };
    const f = file(date);
    if (!f) return { ...base, available: false, source: 'none', reason: dir ? `no plan file starting "GLR ${date}" in the schedule folder` : 'SCHEDULE_DIR is not set', items: [] };
    let plan;
    try { plan = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { return { ...base, available: false, source: 'file', reason: `the plan file could not be read: ${err.message}`, items: [] }; }
    const items = (Array.isArray(plan.items) ? plan.items : []).flatMap((raw, index) => {
      if (!raw || typeof raw !== 'object') return [];
      let startsAt = null;
      if (typeof raw.startsAt === 'string' && Number.isFinite(Date.parse(raw.startsAt))) startsAt = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw.startsAt) ? Date.parse(raw.startsAt) : (tz.parseMachineTimestamp(raw.startsAt, broadcastTz) ?? null);
      else if (typeof raw.time === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(raw.time)) {
        const [h, m, s] = raw.time.split(':').map(Number);
        const [y, mo, d] = date.split('-').map(Number);
        startsAt = tz.localToInstant({ year: y, month: mo, day: d, hour: h, minute: m, second: s || 0 }, broadcastTz);
      }
      const kind = KINDS.includes(raw.kind) ? raw.kind : raw.dynamic ? 'dynamic-slot' : 'song';
      const item = { index, kind, startsAt: startsAt === null ? null : tz.formatIso(startsAt, broadcastTz), ...(raw.artist ? { artist: String(raw.artist) } : {}), ...(raw.title ? { title: String(raw.title) } : {}), ...(Number.isFinite(raw.durationSeconds) ? { durationSeconds: raw.durationSeconds } : {}) };
      if (kind === 'dynamic-slot') {
        const d = raw.dynamic && typeof raw.dynamic === 'object' ? raw.dynamic : {};
        item.dynamic = { slotKind: SLOT_KINDS.includes(d.slotKind) ? d.slotKind : 'station-id', ...(d.personaId ? { personaId: String(d.personaId) } : {}), leadSeconds: Number.isFinite(d.leadSeconds) ? d.leadSeconds : 300 + (index > 0 && plan.items[index - 1] && Number.isFinite(plan.items[index - 1].durationSeconds) ? plan.items[index - 1].durationSeconds : 0), ...(index > 0 && plan.items[index - 1] && Number.isFinite(plan.items[index - 1].durationSeconds) ? { precedingSeconds: plan.items[index - 1].durationSeconds } : {}), ...(d.fallbackClipId ? { fallbackClipId: String(d.fallbackClipId) } : {}), ...(d.constraints && typeof d.constraints === 'object' ? { constraints: d.constraints } : {}) };
      }
      return [item];
    });
    return { ...base, available: true, source: 'file', name: String(plan.name || path.basename(f, '.json')), items };
  }

  // The dynamic slots of a day, in the shape the hub takes.
  function dynamicSlots(date) {
    const day = forDate(date);
    return day.items.filter((i) => i.kind === 'dynamic-slot' && i.startsAt).map((i) => ({ kind: i.dynamic.slotKind, startsAt: i.startsAt, leadSeconds: i.dynamic.leadSeconds, precedingSeconds: i.dynamic.precedingSeconds, personaId: i.dynamic.personaId, fallbackClipId: i.dynamic.fallbackClipId, constraints: i.dynamic.constraints || {}, source: 'schedule', ref: `${day.date}#${i.index}` }));
  }

  return { forDate, dynamicSlots };
}

module.exports = { createSchedule, KINDS, SLOT_KINDS };
