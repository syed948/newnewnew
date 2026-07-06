// Quick smoke test: calls each serverless handler function directly, the same way
// Vercel's runtime would, using mock req/res objects - no HTTP server needed.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:testpass@localhost:5432/dialer_test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.APP_BASE_URL = 'https://dialer.brandigade.com';
process.env.ALLOWED_ORIGINS = 'https://dialer.brandigade.com';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@brandigade.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'change-me-immediately';

function mockReq({ method = 'GET', body = {}, headers = {}, query = {} } = {}) {
  return { method, body, headers, query, url: '/test', socket: {} };
}

function mockRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    status(code) { this._status = code; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
    headersSent: false
  };
  return res;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  const authRoute = require('./api/auth/[...action]');
  const usersIndex = require('./api/admin/users/index');
  const usersAction = require('./api/admin/users/[...action]');
  const settings = require('./api/admin/settings');
  const callsRoute = require('./api/calls/[...action]');
  const smsRoute = require('./api/sms/[...action]');
  const adminCalls = require('./api/admin/calls');
  const adminMessages = require('./api/admin/messages');

  const login = (req, res) => { req.query.action = ['login']; return authRoute(req, res); };
  const meEndpoint = (req, res) => { req.query.action = ['me']; return authRoute(req, res); };
  const userById = (req, res) => { req.query.action = [req.query.id]; return usersAction(req, res); };
  const resetPw = (req, res) => { req.query.action = [req.query.id, 'reset-password']; return usersAction(req, res); };
  const tokenEndpoint = (req, res) => { req.query.action = ['token']; return callsRoute(req, res); };
  const smsIndex = (req, res) => { req.query.action = [req.method === 'GET' ? 'list' : 'send']; return smsRoute(req, res); };

  // 1. Login as bootstrap admin
  let res = mockRes();
  await login(mockReq({ method: 'POST', body: { email: 'admin@brandigade.com', password: 'change-me-immediately' } }), res);
  const loginBody = JSON.parse(res._body);
  assert(res._status === 200 && loginBody.success && loginBody.token, 'login returns a token');
  const adminToken = loginBody.token;

  // 2. Wrong password should fail cleanly with JSON
  res = mockRes();
  await login(mockReq({ method: 'POST', body: { email: 'admin@brandigade.com', password: 'wrong' } }), res);
  const badLogin = JSON.parse(res._body);
  assert(res._status === 401 && badLogin.success === false && typeof badLogin.message === 'string', 'bad login returns clean JSON error');

  // 3. /api/auth/me with token
  res = mockRes();
  await meEndpoint(mockReq({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }), res);
  const meBody = JSON.parse(res._body);
  assert(res._status === 200 && meBody.user.role === 'admin', '/api/auth/me returns the admin user');

  // 4. Reject unauthenticated request
  res = mockRes();
  await usersIndex(mockReq({ method: 'GET' }), res);
  assert(res._status === 401, 'unauthenticated request to admin endpoint is rejected');

  // 5. Create a user as admin
  res = mockRes();
  await usersIndex(mockReq({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: { email: 'jafar@brandigade.com', name: 'Jafar Ali', role: 'user', caller_id: '+15550001234' }
  }), res);
  const createBody = JSON.parse(res._body);
  assert(res._status === 201 && createBody.temporary_password, 'admin can create a teammate and gets a temp password');
  const newUserId = createBody.user.id;

  // 6. List users
  res = mockRes();
  await usersIndex(mockReq({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }), res);
  const listBody = JSON.parse(res._body);
  assert(res._status === 200 && listBody.users.length >= 2, 'admin can list users');

  // 7. Patch the user (disable)
  res = mockRes();
  await userById(mockReq({
    method: 'PATCH',
    headers: { authorization: `Bearer ${adminToken}` },
    query: { id: String(newUserId) },
    body: { active: false }
  }), res);
  assert(res._status === 200, 'admin can disable a user');

  // 8. Reset password
  res = mockRes();
  await resetPw(mockReq({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    query: { id: String(newUserId) }
  }), res);
  const resetBody = JSON.parse(res._body);
  assert(res._status === 200 && resetBody.temporary_password, 'admin can reset a user password');

  // 9. Non-admin (the new user) cannot access admin endpoints
  res = mockRes();
  await login(mockReq({ method: 'POST', body: { email: 'jafar@brandigade.com', password: resetBody.temporary_password } }), res);
  const repLoginBody = JSON.parse(res._body);
  // account is disabled, so this should fail
  assert(res._status === 401, 'disabled user cannot log in');

  // re-enable and retry
  res = mockRes();
  await userById(mockReq({
    method: 'PATCH',
    headers: { authorization: `Bearer ${adminToken}` },
    query: { id: String(newUserId) },
    body: { active: true }
  }), res);
  assert(res._status === 200, 'admin can re-enable a user');

  res = mockRes();
  await login(mockReq({ method: 'POST', body: { email: 'jafar@brandigade.com', password: resetBody.temporary_password } }), res);
  const repLogin2 = JSON.parse(res._body);
  assert(res._status === 200 && repLogin2.user.role === 'user', 're-enabled rep can log in');
  const repToken = repLogin2.token;

  res = mockRes();
  await usersIndex(mockReq({ method: 'GET', headers: { authorization: `Bearer ${repToken}` } }), res);
  assert(res._status === 403, 'non-admin rep is forbidden from admin endpoints');

  // 10. Settings get/put as admin
  res = mockRes();
  await settings(mockReq({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }), res);
  const settingsBody = JSON.parse(res._body);
  assert(res._status === 200 && 'twilio_account_sid' in settingsBody.settings, 'admin can read settings');

  res = mockRes();
  await settings(mockReq({
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}` },
    body: { twilio_account_sid: 'ACtestsid1234567890', twilio_caller_id: '+15550009999' }
  }), res);
  assert(res._status === 200, 'admin can update settings');

  // 11. Voice token without full Twilio config should fail with a clear message, not crash
  res = mockRes();
  await tokenEndpoint(mockReq({ method: 'GET', headers: { authorization: `Bearer ${repToken}` } }), res);
  const tokenBody = JSON.parse(res._body);
  assert(res._status === 400 && /not fully configured/.test(tokenBody.message), 'voice token endpoint fails gracefully when Twilio Voice is not fully configured');

  // 12. SMS send without caller_id configured should fail gracefully (not crash) - expect Twilio auth error since fake SID, but should be JSON
  res = mockRes();
  await smsIndex(mockReq({
    method: 'POST',
    headers: { authorization: `Bearer ${repToken}` },
    body: { to: '+15550001111', body: 'test' }
  }), res);
  const smsBody = JSON.parse(res._body);
  assert(res._status >= 400 && smsBody.success === false, 'SMS send fails gracefully with bad/fake Twilio creds (JSON, not a crash)');

  // 13. Org-wide admin views
  res = mockRes();
  await adminCalls(mockReq({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }), res);
  assert(res._status === 200, 'admin can view org-wide calls');

  res = mockRes();
  await adminMessages(mockReq({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }), res);
  assert(res._status === 200, 'admin can view org-wide messages');

  // 14. Delete the test user
  res = mockRes();
  await userById(mockReq({
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
    query: { id: String(newUserId) }
  }), res);
  assert(res._status === 200, 'admin can delete a user');

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
