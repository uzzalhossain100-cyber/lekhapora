const { send } = require('../lib/http');
const { clearSessionCookie } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Only POST requests are allowed.' });
  }
  clearSessionCookie(req, res);
  return send(res, 200, { ok: true });
};
