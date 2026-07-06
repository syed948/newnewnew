// api/calls/[...action].js
//
// One function handling every /api/calls/* route (token, voice webhook, status webhook,
// recent-calls list, manual log) instead of five separate functions - see the note in
// api/auth/[...action].js about Vercel's 12-function cap on the Hobby tier.
//
// Twilio Console webhook URLs are unaffected by this consolidation:
//   Voice Request URL  -> https://dialer.brandigade.com/api/calls/voice
//   (status callback is set programmatically to /api/calls/status, see below)
const db = require('../../lib/database');
const { withApi, withAuth, ok, fail, getActionSegments } = require('../../lib/http');
const { getSettings, VoiceResponse, validateTwilioSignature, AccessToken, VoiceGrant } = require('../../lib/twilio');
const { logInfo, logError } = require('../../lib/logger');

function identityFor(userId) {
  return `user_${userId}`;
}
function identityFromClient(from) {
  const m = /^client:?user_(\d+)$/.exec(from || '');
  return m ? Number(m[1]) : null;
}
function sendTwiml(res, twiml) {
  res.status(200).setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());
}

// GET /api/calls/token - Voice access token for the browser softphone
async function handleToken(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => {
    const s = await getSettings();
    if (!s.twilio_account_sid || !s.twilio_api_key || !s.twilio_api_secret || !s.twilio_twiml_app_sid) {
      return fail(res2, 400,
        'Twilio Voice is not fully configured yet. An admin needs to add API Key/Secret and a TwiML App SID in Admin Panel > Settings.'
      );
    }
    const identity = identityFor(req2.user.id);
    const token = new AccessToken(s.twilio_account_sid, s.twilio_api_key, s.twilio_api_secret, { identity, ttl: 3600 });
    token.addGrant(new VoiceGrant({ outgoingApplicationSid: s.twilio_twiml_app_sid, incomingAllow: true }));
    ok(res2, { token: token.toJwt(), identity });
  })(req, res);
}

// POST /api/calls/voice - TwiML webhook, Twilio calls this to place the bridge call
async function handleVoice(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const s = await getSettings();

  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'true') {
    const signature = req.headers['x-twilio-signature'];
    const url = `${process.env.APP_BASE_URL}/api/calls/voice`;
    if (!validateTwilioSignature({ authToken: s.twilio_auth_token, signature, url, params: req.body })) {
      logError('twilio_signature_invalid', { url });
      return fail(res, 403, 'Invalid Twilio signature.');
    }
  }

  let toParam = req.body?.destination || req.body?.To || '';
  if (Array.isArray(toParam)) toParam = toParam[0] || '';
  const to = String(toParam).trim();

  let fromParam = req.body?.From || '';
  if (Array.isArray(fromParam)) fromParam = fromParam[0] || '';
  const userId = identityFromClient(String(fromParam));
  const callerId = s.twilio_caller_id || undefined;
  const twiml = new VoiceResponse();

  if (!to) {
    twiml.say('No destination number was provided.');
    return sendTwiml(res, twiml);
  }

  const dial = twiml.dial({
    callerId,
    answerOnBridge: true,
    action: `${process.env.APP_BASE_URL || ''}/api/calls/status`,
    method: 'POST'
  });

  if (/^client:/.test(to)) dial.client(to.replace(/^client:/, ''));
  else dial.number({}, to);

  if (userId) {
    try {
      await db.query(
        `INSERT INTO calls (user_id, call_sid, direction, from_number, to_number, status)
         VALUES ($1, $2, 'outbound', $3, $4, 'in-progress')`,
        [userId, req.body.CallSid || null, callerId || 'unknown', to]
      );
      logInfo('call_started', { userId, to });
    } catch (err) {
      logError('call_log_insert_failed', { message: err.message });
    }
  }

  sendTwiml(res, twiml);
}

// POST /api/calls/status - Twilio status callback with final outcome/duration
async function handleStatus(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const { CallSid, DialCallStatus, DialCallDuration } = req.body || {};
  if (CallSid) {
    try {
      await db.query('UPDATE calls SET status = $1, duration = $2 WHERE call_sid = $3', [
        DialCallStatus || 'completed', Number(DialCallDuration || 0), CallSid
      ]);
      logInfo('call_status_updated', { CallSid, status: DialCallStatus });
    } catch (err) {
      logError('call_status_update_failed', { message: err.message });
    }
  }
  sendTwiml(res, new VoiceResponse());
}

// GET /api/calls/list - recent calls for the logged-in user
async function handleList(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => {
    const { rows } = await db.query(
      'SELECT * FROM calls WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req2.user.id]
    );
    ok(res2, { calls: rows });
  })(req, res);
}

// POST /api/calls/log - manual fallback log entry
async function handleLog(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => {
    const { to_number, call_sid, status } = req2.body || {};
    if (!to_number) return fail(res2, 400, 'to_number is required.');
    await db.query(
      `INSERT INTO calls (user_id, call_sid, direction, from_number, to_number, status)
       VALUES ($1, $2, 'outbound', $3, $4, $5)`,
      [req2.user.id, call_sid || null, req2.user.caller_id || 'unknown', to_number, status || 'queued']
    );
    ok(res2, {}, 201);
  })(req, res);
}

module.exports = withApi(async (req, res) => {
  const [route] = getActionSegments(req, 'calls');

  switch (route) {
    case 'token': return handleToken(req, res);
    case 'voice': return handleVoice(req, res);
    case 'status': return handleStatus(req, res);
    case 'list': return handleList(req, res);
    case 'log': return handleLog(req, res);
    default: return fail(res, 404, 'Unknown calls route.');
  }
});
