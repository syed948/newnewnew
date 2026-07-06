// lib/twilio.js — single place that talks to Twilio. Nothing else should call require('twilio') directly.
const twilio = require('twilio');
const db = require('./database');

async function getSettings() {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const s = {};
  for (const row of rows) s[row.key] = row.value;
  return s;
}

// Masks secrets before they're sent to the browser (Admin > Settings screen).
function maskSettingsForClient(s) {
  const mask = (v) => (v ? `${'*'.repeat(Math.max(v.length - 4, 0))}${v.slice(-4)}` : '');
  return {
    twilio_account_sid: s.twilio_account_sid || '',
    twilio_auth_token: mask(s.twilio_auth_token),
    twilio_api_key: s.twilio_api_key || '',
    twilio_api_secret: mask(s.twilio_api_secret),
    twilio_twiml_app_sid: s.twilio_twiml_app_sid || '',
    twilio_caller_id: s.twilio_caller_id || ''
  };
}

async function saveSettings(patch) {
  const allowed = [
    'twilio_account_sid', 'twilio_auth_token', 'twilio_api_key',
    'twilio_api_secret', 'twilio_twiml_app_sid', 'twilio_caller_id'
  ];
  for (const key of allowed) {
    if (patch[key] !== undefined && patch[key] !== '') {
      await db.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, patch[key]]
      );
      global.__bgTwilioClient = null; // credentials changed - force REST client rebuild
    }
  }
}

// Reused across requests on the same warm container; rebuilt if credentials changed.
async function getTwilioClient() {
  const s = await getSettings();
  if (!s.twilio_account_sid || !s.twilio_auth_token) {
    throw new Error('Twilio credentials are not configured yet. Add them in Admin Panel > Settings.');
  }
  if (!global.__bgTwilioClient || global.__bgTwilioClientSid !== s.twilio_account_sid) {
    global.__bgTwilioClient = twilio(s.twilio_account_sid, s.twilio_auth_token);
    global.__bgTwilioClientSid = s.twilio_account_sid;
  }
  return global.__bgTwilioClient;
}

// Verifies the X-Twilio-Signature header on inbound webhooks (voice/status/sms).
// `url` must be the exact public HTTPS URL Twilio was configured to call.
function validateTwilioSignature({ authToken, signature, url, params }) {
  if (!authToken || !signature) return false;
  return twilio.validateRequest(authToken, signature, url, params || {});
}

module.exports = {
  getSettings,
  maskSettingsForClient,
  saveSettings,
  getTwilioClient,
  validateTwilioSignature,
  AccessToken: twilio.jwt.AccessToken,
  VoiceGrant: twilio.jwt.AccessToken.VoiceGrant,
  VoiceResponse: twilio.twiml.VoiceResponse,
  MessagingResponse: twilio.twiml.MessagingResponse
};
