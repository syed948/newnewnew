// lib/http.js — small helpers to replace what Express middleware used to do,
// since plain Vercel Serverless Functions have no middleware chain of their own.
const db = require('./database');
const { getAuthedUser } = require('./auth');
const { logError } = require('./logger');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://dialer.brandigade.com,https://brandigade.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (ALLOWED_ORIGINS.length === 1) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data));
}

function fail(res, status, message) {
  json(res, status, { success: false, message });
}

function ok(res, data, status = 200) {
  json(res, status, { success: true, ...data });
}

// Wraps a handler with CORS + security headers + schema bootstrap + JSON error safety net.
// Every api/*.js file should be exported through this so a thrown error never leaks HTML.
function withApi(handler) {
  return async (req, res) => {
    applyCors(req, res);
    applySecurityHeaders(res);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    try {
      await db.ensureSchema();
      await handler(req, res);
    } catch (err) {
      logError('unhandled_api_error', { path: req.url, message: err.message });
      if (!res.headersSent) fail(res, 500, 'Something went wrong. Please try again.');
    }
  };
}

// Attaches req.user from the JWT, or responds 401. Compose with withApi().
function withAuth(handler) {
  return async (req, res) => {
    const user = getAuthedUser(req);
    if (!user) return fail(res, 401, 'Missing or invalid session. Please sign in again.');
    req.user = user;
    return handler(req, res);
  };
}

function withAdmin(handler) {
  return withAuth(async (req, res) => {
    if (req.user.role !== 'admin') return fail(res, 403, 'Admin access required.');
    return handler(req, res);
  });
}

// ---- Minimal rate limiting (per warm lambda instance) ----
// True cross-instance rate limiting on serverless needs a shared store (Redis/Upstash).
// This in-memory version still meaningfully slows down brute-force attempts on a single
// warm container and costs nothing extra to run; upgrade to Upstash Ratelimit if you need
// guarantees across every concurrent instance.
const attempts = new Map();

function rateLimit(key, { max = 8, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  attempts.set(key, entry);
  return entry.count <= max;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

module.exports = { json, ok, fail, withApi, withAuth, withAdmin, rateLimit, clientIp };
