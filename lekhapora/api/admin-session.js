const { send } = require('../lib/http');
const { readSession } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Only GET requests are allowed.' });
  }
  const session = readSession(req);
  return send(res, 200, session ? { loggedIn: true, id: session.id } : { loggedIn: false });
};
