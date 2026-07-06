// api/sms/[...action].js
//
// One function handling /api/sms/list (history), /api/sms/send, and /api/sms/inbound
// (Twilio's "a message comes in" webhook) instead of two separate functions.
// Twilio Console: point "A message comes in" at https://dialer.brandigade.com/api/sms/inbound
const db = require('../../lib/database');
const { withApi, withAuth, ok, fail } = require('../../lib/http');
const { getTwilioClient, getSettings, MessagingResponse, validateTwilioSignature } = require('../../lib/twilio');
const { logInfo, logError } = require('../../lib/logger');

async function handleList(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => {
    const { rows } = await db.query(
      'SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
      [req2.user.id]
    );
    ok(res2, { messages: rows });
  })(req, res);
}

async function handleSend(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  return withAuth(async (req2, res2) => {
    const { to, body } = req2.body || {};
    if (!to || !body) return fail(res2, 400, 'A destination number and message body are required.');

    try {
      const client = await getTwilioClient();
      const s = await getSettings();
      if (!s.twilio_caller_id) {
        return fail(res2, 400, 'No sending number is configured yet. Add one in Admin Panel > Settings.');
      }
      const msg = await client.messages.create({ to, from: s.twilio_caller_id, body });
      await db.query(
        `INSERT INTO messages (user_id, message_sid, direction, from_number, to_number, body, status)
         VALUES ($1, $2, 'outbound', $3, $4, $5, $6)`,
        [req2.user.id, msg.sid, s.twilio_caller_id, to, body, msg.status]
      );
      logInfo('sms_sent', { userId: req2.user.id, sid: msg.sid });
      ok(res2, { sid: msg.sid, status: msg.status }, 201);
    } catch (err) {
      logError('sms_send_failed', { message: err.message });
      fail(res2, 500, err.message || 'Failed to send message.');
    }
  })(req, res);
}

async function handleInbound(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const s = await getSettings();
  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'true') {
    const signature = req.headers['x-twilio-signature'];
    const url = `${process.env.APP_BASE_URL}/api/sms/inbound`;
    if (!validateTwilioSignature({ authToken: s.twilio_auth_token, signature, url, params: req.body })) {
      logError('twilio_signature_invalid', { url });
      return fail(res, 403, 'Invalid Twilio signature.');
    }
  }

  const { From, To, Body, MessageSid } = req.body || {};
  try {
    const { rows } = await db.query('SELECT id FROM users WHERE caller_id = $1', [To]);
    const ownerId = rows[0]?.id || 0;
    await db.query(
      `INSERT INTO messages (user_id, message_sid, direction, from_number, to_number, body, status)
       VALUES ($1, $2, 'inbound', $3, $4, $5, 'received')`,
      [ownerId, MessageSid, From, To, Body]
    );
    logInfo('sms_inbound', { to: To });
  } catch (err) {
    logError('sms_inbound_failed', { message: err.message });
  }

  res.status(200).setHeader('Content-Type', 'text/xml').send(new MessagingResponse().toString());
}

module.exports = withApi(async (req, res) => {
  const segments = Array.isArray(req.query.action) ? req.query.action : [req.query.action].filter(Boolean);
  const [route] = segments;

  switch (route) {
    case 'list': return handleList(req, res);
    case 'send': return handleSend(req, res);
    case 'inbound': return handleInbound(req, res);
    default: return fail(res, 404, 'Unknown sms route.');
  }
});
