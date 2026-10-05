const { send, readBody, clientIp } = require('../lib/http');
const { adminId, passwordOk, setSessionCookie, loginBlocked, registerLoginFailure, clearLoginFailures } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Only POST requests are allowed.' });
  }
  try {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      return send(res, 429, { error: 'অনেকবার ভুল চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।' });
    }
    const body = await readBody(req);
    const id = String(body.id || body.username || '').trim();
    const password = String(body.password || '');
    if (!passwordOk(id, password)) {
      registerLoginFailure(ip);
      return send(res, 401, { error: 'আইডি বা পাসওয়ার্ড সঠিক নয়।' });
    }
    clearLoginFailures(ip);
    setSessionCookie(req, res, adminId());
    return send(res, 200, { ok: true, id: adminId() });
  } catch (error) {
    return send(res, 500, { error: 'লগইন সম্পন্ন করা যায়নি।' });
  }
};
