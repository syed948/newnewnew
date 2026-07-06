// api/auth/[...action].js
//
// Consolidated so /api/auth/login, /api/auth/logout, /api/auth/verify, and /api/auth/me
// are ONE Vercel Function instead of four - Vercel's free/Hobby tier caps a project at
// 12 serverless functions total, so related routes are grouped behind catch-all files
// like this one rather than one file per endpoint.
const { withApi, withAuth, ok, fail, rateLimit, clientIp } = require('../../lib/http');
const { authenticate, createToken, createRefreshToken, refreshAccessToken } = require('../../lib/auth');
const { logInfo, logError } = require('../../lib/logger');

async function handleLogin(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const ip = clientIp(req);
  if (!rateLimit(`login:${ip}`, { max: 8, windowMs: 60_000 })) {
    return fail(res, 429, 'Too many login attempts. Wait a minute and try again.');
  }

  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'Email and password are required.');

  try {
    const user = await authenticate(email, password);
    if (!user) {
      logInfo('login_failed', { email });
      return fail(res, 401, 'Invalid email or password.');
    }
    const token = createToken(user);
    const refreshToken = createRefreshToken(user);
    logInfo('login_success', { userId: user.id });
    ok(res, {
      token,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, caller_id: user.caller_id }
    });
  } catch (err) {
    logError('login_error', { message: err.message });
    fail(res, 500, 'Could not sign in right now.');
  }
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => {
    logInfo('logout', { userId: req2.user.id });
    ok(res2, { message: 'Logged out.' });
  })(req, res);
}

async function handleVerify(req, res) {
  if (req.method === 'POST') {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return fail(res, 400, 'refreshToken is required.');
    try {
      const token = await refreshAccessToken(refreshToken);
      return ok(res, { token });
    } catch (err) {
      logError('refresh_failed', { message: err.message });
      return fail(res, 401, 'Refresh token is invalid or expired.');
    }
  }
  if (req.method === 'GET') {
    return withAuth(async (req2, res2) => ok(res2, { user: req2.user }))(req, res);
  }
  return fail(res, 405, 'Method not allowed');
}

async function handleMe(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => ok(res2, { user: req2.user }))(req, res);
}

module.exports = withApi(async (req, res) => {
  const segments = Array.isArray(req.query.action) ? req.query.action : [req.query.action].filter(Boolean);
  const [route] = segments;

  switch (route) {
    case 'login': return handleLogin(req, res);
    case 'logout': return handleLogout(req, res);
    case 'verify': return handleVerify(req, res);
    case 'me': return handleMe(req, res);
    default: return fail(res, 404, 'Unknown auth route.');
  }
});
