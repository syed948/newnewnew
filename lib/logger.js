// lib/logger.js — structured, secret-safe logging for serverless functions.
// Vercel captures stdout/stderr automatically into its function logs, so plain
// console.log/error with a consistent JSON shape is all that's needed here.

const REDACT_KEYS = new Set([
  'password', 'password_hash', 'temporary_password', 'token', 'authorization',
  'auth_token', 'twilio_auth_token', 'twilio_api_secret', 'twilio_account_sid',
  'twilio_api_key', 'jwt', 'secret'
]);

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

function emit(level, event, meta) {
  const entry = { level, event, ts: new Date().toISOString(), ...redact(meta) };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  logInfo: (event, meta) => emit('info', event, meta),
  logError: (event, meta) => emit('error', event, meta)
};
