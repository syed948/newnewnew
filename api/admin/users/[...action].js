// api/admin/users/[...action].js
//
// Handles /api/admin/users/:id (PATCH, DELETE) and /api/admin/users/:id/reset-password (POST)
// in one function, so the two-route pair doesn't cost two entries against Vercel's
// serverless function limit. /api/admin/users itself (list/create) stays in
// api/admin/users/index.js since that's an exact path, not a dynamic one.
const crypto = require('crypto');
const db = require('../../../lib/database');
const { withApi, withAdmin, ok, fail, getActionSegments } = require('../../../lib/http');
const { hashPassword } = require('../../../lib/auth');
const { logInfo } = require('../../../lib/logger');

function generatePassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

async function handleUserRecord(req, res, id) {
  if (req.method === 'PATCH') {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    const user = rows[0];
    if (!user) return fail(res, 404, 'User not found.');

    const { name, role, caller_id, active } = req.body || {};
    await db.query(
      `UPDATE users SET name = $1, role = $2, caller_id = $3, active = $4 WHERE id = $5`,
      [
        name ?? user.name,
        role === 'admin' ? 'admin' : role === 'user' ? 'user' : user.role,
        caller_id !== undefined ? caller_id : user.caller_id,
        active !== undefined ? Boolean(active) : user.active,
        id
      ]
    );
    logInfo('user_updated', { userId: id, byAdmin: req.user.id });
    return ok(res, {});
  }

  if (req.method === 'DELETE') {
    if (id === req.user.id) return fail(res, 400, "You can't delete your own account while logged in.");
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    logInfo('user_deleted', { userId: id, byAdmin: req.user.id });
    return ok(res, {});
  }

  return fail(res, 405, 'Method not allowed');
}

async function handleResetPassword(req, res, id) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const { rows } = await db.query('SELECT id FROM users WHERE id = $1', [id]);
  if (!rows.length) return fail(res, 404, 'User not found.');

  const tempPassword = generatePassword();
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(tempPassword), id]);
  logInfo('password_reset', { userId: id, byAdmin: req.user.id });
  ok(res, { temporary_password: tempPassword });
}

module.exports = withApi(withAdmin(async (req, res) => {
  const [idStr, sub] = getActionSegments(req, 'users');
  const id = Number(idStr);
  if (!id) return fail(res, 400, 'Invalid user id.');

  if (sub === 'reset-password') return handleResetPassword(req, res, id);
  if (!sub) return handleUserRecord(req, res, id);
  return fail(res, 404, 'Unknown route.');
}));
