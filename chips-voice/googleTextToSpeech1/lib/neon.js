// Neon Postgres connection, used only when DATABASE_URL is set (otherwise the JSON file store is used).
//
//   DATABASE_URL  Neon connection string, e.g. postgres://user:pass@ep-xxx.neon.tech/db?sslmode=require
//
// The pool is created lazily: requiring this file opens no connection.
const { Pool } = require('pg');

function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a postgres:// URL');
  // Neon requires TLS. Refuse a URL that turns it off.
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode === 'disable') throw new Error('DATABASE_URL must not disable sslmode (Neon requires TLS)');
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: true }, max: 4 });
  // Neon closes idle connections; without a listener pg would crash the process.
  pool.on('error', (err) => console.error(`neon: idle client error: ${err.message}`));
  return pool;
}

module.exports = { createPool };
