// A tiny store for the clip catalogue and schedules.
// Default: a JSON file. One process owns the file; writes are atomic (temp file + rename) and debounced.
// With DATABASE_URL (Neon Postgres): the same `data` shape, kept in one table as one JSON row per kind.
// The Postgres store loads in the background; `ready` resolves once `data` is filled in place,
// so callers that hold references to data.clips / data.schedules keep working.
const fs = require('fs');
const path = require('path');

function createStore(file, defaults = {}) {
  let data = JSON.parse(JSON.stringify(defaults));
  if (file && fs.existsSync(file)) {
    try {
      data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      // Keep the unreadable file for inspection instead of overwriting it.
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    }
  }

  let timer = null;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function save() {
    if (!file || timer) return;
    timer = setTimeout(flush, 200);
    if (timer.unref) timer.unref();
  }

  return { data, save, flush, ready: Promise.resolve() };
}

const TABLE = 'app_store';

// pool: anything with query(text, params) -> { rows } (a pg Pool in production, a fake in tests).
// legacyFile: an existing library.json, imported once when the table is empty.
function createPgStore({ pool, defaults = {}, legacyFile = null, namespace = 'library', debounceMs = 200, onError = console.error }) {
  const data = JSON.parse(JSON.stringify(defaults));
  const kinds = Object.keys(defaults);
  const rowId = (kind) => `${namespace}:${kind}`;
  let timer = null;
  let dirty = false;
  let chain = Promise.resolve();

  async function load() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id text PRIMARY KEY,
      kind text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await pool.query(`SELECT id, kind, data FROM ${TABLE} WHERE id LIKE $1`, [`${namespace}:%`]);
    if (rows.length) {
      for (const row of rows) {
        const kind = row.id.slice(namespace.length + 1);
        if (kinds.includes(kind)) Object.assign(data[kind], row.data);
      }
      return;
    }
    // Empty table: import the JSON file once, if there is one.
    if (!legacyFile || !fs.existsSync(legacyFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      for (const kind of kinds) if (parsed[kind]) Object.assign(data[kind], parsed[kind]);
      dirty = true;
    } catch (err) {
      fs.renameSync(legacyFile, `${legacyFile}.corrupt-${Date.now()}`);
    }
  }

  const ready = load();

  async function write() {
    await ready;
    for (const kind of kinds) {
      await pool.query(
        `INSERT INTO ${TABLE} (id, kind, data, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [rowId(kind), kind, JSON.stringify(data[kind])],
      );
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    dirty = false;
    chain = chain.then(write).catch((err) => {
      dirty = true;
      onError(`store: write failed: ${err.message}`);
    });
    return chain;
  }

  function save() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    if (timer.unref) timer.unref();
  }

  // Once the import has run, write it back so the table holds the file's contents.
  // A failed load is logged; writes then wait on `ready` and fail too, so the table is never overwritten with empty data.
  ready.then(() => { if (dirty) flush(); }, (err) => onError(`store: load failed: ${err.message}`));

  return { data, save, flush, ready };
}

// The one entry point for app.js. A databaseUrl (or an injected pool, for tests) selects Postgres.
function openStore(file, defaults = {}, { databaseUrl = '', pool = null } = {}) {
  if (!pool && !databaseUrl) return createStore(file, defaults);
  const client = pool || require('./neon').createPool(databaseUrl);
  return createPgStore({ pool: client, defaults, legacyFile: file });
}

module.exports = { createStore, createPgStore, openStore };
