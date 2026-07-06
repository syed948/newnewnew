// api/admin/settings.js
const { withApi, withAdmin, ok, fail } = require('../../lib/http');
const { getSettings, maskSettingsForClient, saveSettings } = require('../../lib/twilio');
const { logInfo } = require('../../lib/logger');

module.exports = withApi(withAdmin(async (req, res) => {
  if (req.method === 'GET') {
    const settings = await getSettings();
    return ok(res, { settings: maskSettingsForClient(settings) });
  }

  if (req.method === 'PUT') {
    await saveSettings(req.body || {});
    logInfo('settings_updated', { byAdmin: req.user.id });
    return ok(res, {});
  }

  return fail(res, 405, 'Method not allowed');
}));
