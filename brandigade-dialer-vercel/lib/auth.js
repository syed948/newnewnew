// lib/auth.js — reusable JWT + credential helpers shared by every serverless function.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./database');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the environment.');
  return secret;
}

// ---- Token lifecycle ----

function createToken(user, { expiresIn = '12h' } = {}) {
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    caller_id: user.caller_id
  };
  return jwt.sign(payload, getSecret(), { expiresIn });
}

// A short-lived refresh token, used only to mint a new access token via createToken().
function createRefreshToken(user) {
  return jwt.sign({ id: user.id, type: 'refresh' }, getSecret(), { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret()); // throws if invalid/expired
}

function decodeToken(token) {
  return jwt.decode(token); // no verification - inspection only
}

async function refreshAccessToken(refreshToken) {
  const decoded = verifyToken(refreshToken);
  if (decoded.type !== 'refresh') throw new Error('Not a refresh token');
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
  const user = rows[0];
  if (!user || !user.active) throw new Error('User no longer active');
  return createToken(user);
}

// ---- Credentials ----

async function authenticate(email, password) {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
  const user = rows[0];
  if (!user || !user.active) return null;
  const ok = bcrypt.compareSync(password, user.password_hash);
  return ok ? user : null;
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

// ---- Request-level helpers ----

function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function getAuthedUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

module.exports = {
  createToken,
  createRefreshToken,
  verifyToken,
  decodeToken,
  refreshAccessToken,
  authenticate,
  hashPassword,
  getBearerToken,
  getAuthedUser
};
