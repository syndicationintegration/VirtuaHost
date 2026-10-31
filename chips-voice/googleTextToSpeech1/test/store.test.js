const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, createPgStore, openStore } = require('../lib/store');
const { createPool } = require('../lib/neon');

// An in-memory stand-in for the one-table Postgres store (only the statements lib/store.js uses).
function fakePool() {
  const rows = new Map();
  return {
    rows,
    async query(text, params = []) {
      if (/^\s*CREATE TABLE/.test(text)) return { rows: [] };
      if (/^\s*SELECT id, kind, data/.test(text)) {
        const prefix = params[0].replace('%', '');
        return { rows: [...rows.values()].filter((r) => r.id.startsWith(prefix)).map((r) => ({ ...r })) };
      }
      if (/^\s*INSERT INTO/.test(text)) {
        const [id, kind, data] = params;
        rows.set(id, { id, kind, data: JSON.parse(data) });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('postgres store round-trips clips and schedules through the same shape', async () => {
  const pool = fakePool();
  const defaults = { clips: {}, schedules: {} };
  const a = createPgStore({ pool, defaults, debounceMs: 1 });
  await a.ready;
  a.data.clips.x = { id: 'x', title: 'Hello' };
  a.data.schedules.s1 = { id: 's1', at: 5 };
  a.save();
  await wait(20);
  await a.flush();

  const b = createPgStore({ pool, defaults });
  await b.ready;
  assert.deepStrictEqual(b.data.clips, { x: { id: 'x', title: 'Hello' } });
  assert.deepStrictEqual(b.data.schedules, { s1: { id: 's1', at: 5 } });
});

test('openStore keeps the JSON file when no DATABASE_URL is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'library.json');
  const s = openStore(file, { clips: {}, schedules: {} }, {});
  s.data.clips.j = { id: 'j' };
  s.flush();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).clips, { j: { id: 'j' } });
});

test('a library.json is imported once into an empty table, with clips and schedules intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  const file = path.join(dir, 'library.json');
  fs.writeFileSync(file, JSON.stringify({ clips: { c1: { id: 'c1', title: 'Jingle' } }, schedules: { s1: { id: 's1', every: 60 } } }));
  const pool = fakePool();
  const s = openStore(file, { clips: {}, schedules: {} }, { pool });
  await s.ready;
  assert.deepStrictEqual(s.data.clips, { c1: { id: 'c1', title: 'Jingle' } });
  assert.deepStrictEqual(s.data.schedules, { s1: { id: 's1', every: 60 } });
  await wait(250); // the import is written back to the table
  const again = openStore(file, { clips: {}, schedules: {} }, { pool });
  await again.ready;
  assert.deepStrictEqual(again.data.clips, { c1: { id: 'c1', title: 'Jingle' } });
});

test('an unreadable library.json is kept aside during Postgres migration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-bad-'));
  const file = path.join(dir, 'library.json');
  fs.writeFileSync(file, '{not json');
  const s = openStore(file, { clips: {}, schedules: {} }, { pool: fakePool() });
  await s.ready;
  assert.deepStrictEqual(s.data.clips, {});
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
});

test('neon pool refuses a missing URL, a non-postgres URL, and sslmode=disable', () => {
  assert.throws(() => createPool(''), /DATABASE_URL is not set/);
  assert.throws(() => createPool('http://example.test/db'), /postgres/);
  assert.throws(() => createPool('postgres://u:p@h/db?sslmode=disable'), /sslmode/);
  assert.ok(createPool('postgres://u:p@ep-x.neon.tech/db?sslmode=require'));
});

test('createStore still reads and writes a plain file (unchanged JSON default)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  const file = path.join(dir, 'db.json');
  const s = createStore(file, { clips: {} });
  s.data.clips.p = { id: 'p' };
  s.flush();
  assert.deepStrictEqual(createStore(file, { clips: {} }).data.clips, { p: { id: 'p' } });
});
