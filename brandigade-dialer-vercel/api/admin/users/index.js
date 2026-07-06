// api/admin/users/index.js
const crypto = require('crypto');
const db = require('../../../lib/database');
const { withApi, withAdmin, ok, fail } = require('../../../lib/http');
const { hashPassword } = require('../../../lib/auth');
const { logInfo } = require('../../../lib/logger');

function generatePassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

module.exports = withApi(withAdmin(async (req, res) => {
  if (req.method === 'GET') {
    const { rows } = await db.query(
      `SELECT id, email, name, role, caller_id, active, created_at
       FROM users ORDER BY created_at DESC`
    );
    return ok(res, { users: rows });
  }

  if (req.method === 'POST') {
    const { email, name, role, caller_id } = req.body || {};
    if (!email || !name) return fail(res, 400, 'Name and email are required.');

    const normalizedEmail = String(email).toLowerCase();
    const { rows: existing } = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.length) return fail(res, 409, 'A user with this email already exists.');

    const tempPassword = generatePassword();
    const hash = hashPassword(tempPassword);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, role, caller_id, active)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
      [normalizedEmail, hash, name, role === 'admin' ? 'admin' : 'user', caller_id || null]
    );

    logInfo('user_created', { userId: rows[0].id, byAdmin: req.user.id });

    return ok(res, {
      user: { id: rows[0].id, email: normalizedEmail, name, role: role || 'user', caller_id: caller_id || null },
      temporary_password: tempPassword
    }, 201);
  }

  return fail(res, 405, 'Method not allowed');
}));
