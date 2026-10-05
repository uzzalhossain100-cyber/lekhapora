const { send, readBody } = require('../lib/http');
const { readSession } = require('../lib/auth');
const { loadCatalog, saveCatalog, canPersist } = require('../lib/catalogStore');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const catalog = await loadCatalog();
      return send(res, 200, { catalog, canPersist: canPersist() });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { error: 'Only GET and POST requests are allowed.' });
    }
    if (!readSession(req)) return send(res, 401, { error: 'সেটিংস বদলাতে আগে লগইন করুন।' });
    const body = await readBody(req);
    const saved = await saveCatalog(body.catalog || body);
    return send(res, 200, {
      ok: true,
      catalog: saved.catalog,
      persisted: saved.persisted,
      via: saved.via,
      warning: saved.persisted ? '' : 'এই ব্রাউজারে সেভ হয়েছে, কিন্তু সবার জন্য লাইভ করতে Vercel-এ GITHUB_TOKEN সেট করুন।'
    });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || 'ক্যাটালগ সেভ করা যায়নি।' });
  }
};
