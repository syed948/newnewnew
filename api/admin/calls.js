// api/admin/calls.js
const db = require('../../lib/database');
const { withApi, withAdmin, ok, fail } = require('../../lib/http');

module.exports = withApi(withAdmin(async (req, res) => {
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  const { rows } = await db.query(
    `SELECT calls.*, users.name AS user_name, users.email AS user_email
     FROM calls JOIN users ON users.id = calls.user_id
     ORDER BY calls.created_at DESC LIMIT 200`
  );
  ok(res, { calls: rows });
}));
