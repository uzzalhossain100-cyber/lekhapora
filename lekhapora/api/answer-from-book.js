const { send, readBody, clientIp } = require('../lib/http');
const { readSession } = require('../lib/auth');
const { loadCatalog } = require('../lib/catalogStore');
const { pdfInfo, slicePdf, MAX_PAGES } = require('../lib/pdfSource');
const { answerFromPdf } = require('../lib/gemini');
const { isAllowedBookUrl } = require('../lib/urls');

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const row = hits.get(ip) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (row.reset < now) {
    row.count = 0;
    row.reset = now + 10 * 60 * 1000;
  }
  row.count += 1;
  hits.set(ip, row);
  return row.count > 40;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Only POST requests are allowed.' });
  }
  try {
    if (limited(clientIp(req))) return send(res, 429, { error: 'একসাথে অনেক অনুরোধ হয়েছে। একটু পরে আবার চেষ্টা করুন।' });
    const body = await readBody(req);
    const bookId = String(body.bookId || '').trim();
    const question = String(body.question || '').trim().slice(0, 1200);
    const action = String(body.action || 'answer');
    if (action === 'answer-upload') {
      if (!question) return send(res, 400, { error: 'প্রশ্ন লিখুন।' });
      const bytes = Buffer.from(String(body.pdfBase64 || ''), 'base64');
      if (bytes.length < 100 || bytes.length > 4 * 1024 * 1024 || bytes.slice(0, 4).toString() !== '%PDF') {
        return send(res, 400, { error: 'বইয়ের পৃষ্ঠা পড়া যায়নি।' });
      }
      const result = await answerFromPdf({
        bytes,
        className: String(body.className || 'শ্রেণী').slice(0, 60),
        bookTitle: String(body.bookTitle || 'নির্বাচিত বই').slice(0, 80),
        question,
        paged: true
      });
      return send(res, 200, result);
    }
    const catalog = await loadCatalog();
    let book = (catalog.books || []).find((item) => item.id === bookId && item.link);
    if (!book && readSession(req) && isAllowedBookUrl(body.url)) {
      book = { id: bookId || 'admin-book', title: String(body.bookTitle || 'নির্বাচিত বই').slice(0, 80), link: String(body.url), classId: '' };
    }
    if (!book) return send(res, 404, { error: 'নির্বাচিত বইয়ের লিংক পাওয়া যায়নি। সেটিংস থেকে বইয়ের URL সেভ করুন।' });
    const className = (catalog.classes || []).find((item) => item.id === book.classId)?.name || String(body.className || 'শ্রেণী').slice(0, 60);
    if (action === 'info') {
      const info = await pdfInfo(book.link);
      return send(res, 200, { ...info, mode: info.bytes <= 7 * 1024 * 1024 ? 'whole' : 'paged', maxPages: MAX_PAGES });
    }
    if (!question) return send(res, 400, { error: 'প্রশ্ন লিখুন।' });
    if (action === 'answer-pages') {
      const startPage = Number(body.startPage) || 1;
      const endPage = Math.min(startPage + 5, Number(body.endPage) || startPage);
      const slice = await slicePdf(book.link, startPage, endPage);
      const result = await answerFromPdf({
        bytes: slice.bytes,
        className,
        bookTitle: book.title,
        question,
        paged: true
      });
      return send(res, 200, { ...result, startPage: slice.start, endPage: slice.end, pageCount: slice.pageCount });
    }
    const info = await pdfInfo(book.link);
    if (info.bytes > 7 * 1024 * 1024) {
      return send(res, 200, { found: false, paged: true, pageCount: info.pageCount, mode: 'paged' });
    }
    const slice = await slicePdf(book.link, 1, Math.min(info.pageCount, MAX_PAGES));
    const result = await answerFromPdf({
      bytes: slice.bytes,
      className,
      bookTitle: book.title,
      question,
      paged: false
    });
    return send(res, 200, { ...result, pageCount: info.pageCount, mode: 'whole' });
  } catch (error) {
    return send(res, error.status || 502, { error: error.message || 'বই থেকে উত্তর তৈরি করা যায়নি।' });
  }
};

module.exports.config = { maxDuration: 60 };
