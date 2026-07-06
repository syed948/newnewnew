// lib/database.js
//
// Why Postgres instead of the old SQLite file:
// Vercel Serverless Functions have no persistent disk - each invocation can run on a fresh
// container, and a file written in one request is not guaranteed to exist in the next.
// SQLite-on-disk (or an in-memory store) would silently lose users, call logs, and message
// history between requests. A managed Postgres instance (Vercel Postgres, Neon, or Supabase
// all work) is required for state to survive across invocations.
//
// This module opens at most one connection pool per warm lambda container (cached on
// `global`, since each cold start gets a fresh module registry) and reuses it across
// requests handled by that container, rather than reconnecting every time.

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { logInfo, logError } = require('./logger');

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Add a Postgres connection string (Vercel Postgres, Neon, or Supabase) ' +
      'to your Vercel Environment Variables.'
    );
  }
  if (!global.__bgPgPool) {
    global.__bgPgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1, // one connection per function instance; rely on your provider's connection pooler (pgbouncer / Neon pooled URL) for concurrency
      ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
    });
  }
  return global.__bgPgPool;
}

async function query(text, params = []) {
  const pool = getPool();
  return pool.query(text, params);
}

async function createSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      caller_id TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_sid TEXT,
      direction TEXT NOT NULL,
      from_number TEXT,
      to_number TEXT,
      status TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      message_sid TEXT,
      direction TEXT NOT NULL,
      from_number TEXT,
      to_number TEXT,
      body TEXT,
      status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function seedSettingsFromEnv() {
  const defaults = {
    twilio_account_sid: process.env.TWILIO_ACCOUNT_SID || '',
    twilio_auth_token: process.env.TWILIO_AUTH_TOKEN || '',
    twilio_api_key: process.env.TWILIO_API_KEY || '',
    twilio_api_secret: process.env.TWILIO_API_SECRET || '',
    twilio_twiml_app_sid: process.env.TWILIO_TWIML_APP_SID || '',
    twilio_caller_id: process.env.TWILIO_CALLER_ID || ''
  };
  for (const [key, value] of Object.entries(defaults)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

async function seedBootstrapAdmin() {
  const { rows } = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (rows.length) return;

  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@brandigade.com').toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me-immediately';
  const hash = bcrypt.hashSync(password, 10);

  await query(
    `INSERT INTO users (email, password_hash, name, role, active) VALUES ($1, $2, 'Admin', 'admin', TRUE)
     ON CONFLICT (email) DO NOTHING`,
    [email, hash]
  );
  logInfo('bootstrap_admin_seeded', { email });
}

// Cached per warm container so repeat requests skip the CREATE TABLE / seed round-trips.
async function ensureSchema() {
  if (global.__bgSchemaReady) return;
  try {
    await createSchema();
    await seedSettingsFromEnv();
    await seedBootstrapAdmin();
    global.__bgSchemaReady = true;
  } catch (err) {
    logError('schema_init_failed', { message: err.message });
    throw err;
  }
}

module.exports = { query, ensureSchema };
