const { send, readBody } = require('../lib/http');
const { readSession } = require('../lib/auth');
const { pdfInfo, slicePdf, MAX_PAGES } = require('../lib/pdfSource');
const { solvePdfPages } = require('../lib/gemini');
const { isAllowedBookUrl } = require('../lib/urls');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Only POST requests are allowed.' });
  }
  try {
    if (!readSession(req)) return send(res, 401, { error: 'সমাধান তৈরি করতে আগে এডমিন লগইন করুন।' });
    const body = await readBody(req);
    const url = String(body.url || '').trim();
    const action = String(body.action || 'info');
    if (action === 'solve-upload') {
      const bytes = Buffer.from(String(body.pdfBase64 || ''), 'base64');
      if (bytes.length < 100 || bytes.length > 4 * 1024 * 1024 || bytes.slice(0, 4).toString() !== '%PDF') {
        return send(res, 400, { error: 'পৃষ্ঠার ফাইলটি পড়া যায়নি। আবার চেষ্টা করুন।' });
      }
      const items = await solvePdfPages({
        bytes,
        className: String(body.className || 'শ্রেণী').slice(0, 60),
        bookTitle: String(body.bookTitle || 'বই').slice(0, 80),
        startPage: Math.max(1, Number(body.startPage) || 1),
        endPage: Math.max(1, Number(body.endPage) || Number(body.startPage) || 1)
      });
      return send(res, 200, { items });
    }
    if (!isAllowedBookUrl(url)) return send(res, 400, { error: 'বইয়ের পাবলিক লিংক দিন।' });
    if (action === 'info') {
      const info = await pdfInfo(url);
      return send(res, 200, { ...info, maxPages: MAX_PAGES });
    }
    const startPage = Math.max(1, Number(body.startPage) || 1);
    const endPage = Math.min(startPage + 2, Number(body.endPage) || startPage);
    const slice = await slicePdf(url, startPage, endPage);
    if (slice.bytes.length > 4.5 * 1024 * 1024 && endPage > startPage) {
      return send(res, 413, { error: 'এই পৃষ্ঠাগুলো একসঙ্গে পড়া যাচ্ছে না। আবার চেষ্টা করলে এক পৃষ্ঠা করে নেওয়া হবে।', retrySingle: true });
    }
    const items = await solvePdfPages({
      bytes: slice.bytes,
      className: String(body.className || 'শ্রেণী').slice(0, 60),
      bookTitle: String(body.bookTitle || 'বই').slice(0, 80),
      startPage: slice.start,
      endPage: slice.end
    });
    return send(res, 200, { items, startPage: slice.start, endPage: slice.end, pageCount: Math.min(slice.pageCount, MAX_PAGES) });
  } catch (error) {
    return send(res, error.status || 502, { error: error.message || 'সমাধান তৈরি করা যায়নি।' });
  }
};

module.exports.config = { maxDuration: 60 };
