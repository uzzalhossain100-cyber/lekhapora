const { PDFDocument } = require('pdf-lib');
const { driveFileId, isAllowedBookUrl } = require('./urls');

const cache = new Map();
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_PAGES = 220;

function remember(url, bytes) {
  cache.set(url, { bytes, at: Date.now() });
  if (cache.size > 2) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function cached(url) {
  const row = cache.get(url);
  if (!row) return null;
  if (Date.now() - row.at > 20 * 60 * 1000) {
    cache.delete(url);
    return null;
  }
  row.at = Date.now();
  return row.bytes;
}

async function fetchBuffer(url, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AmarBoi/1.0; +https://amarboi.vercel.app)',
        Accept: 'application/pdf,application/octet-stream,*/*',
        ...(cookie ? { Cookie: cookie } : {})
      }
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) {
      const error = new Error('বইয়ের ফাইলটি অনেক বড়। ২৮ মেগাবাইটের ছোট PDF লিংক দিন।');
      error.status = 413;
      throw error;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      const error = new Error('বইয়ের ফাইলটি অনেক বড়। ২৮ মেগাবাইটের ছোট PDF লিংক দিন।');
      error.status = 413;
      throw error;
    }
    const setCookie = response.headers.get('set-cookie') || '';
    return { bytes, type: response.headers.get('content-type') || '', setCookie };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikePdf(bytes) {
  return bytes && bytes.length > 4 && bytes.slice(0, 4).toString() === '%PDF';
}

function confirmLink(html, url) {
  const id = driveFileId(url) || (html.match(/name="id"\s+value="([^"]+)"/) || [])[1] || '';
  const confirm = (html.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1]
    || (html.match(/name="confirm"\s+value="([^"]+)"/) || [])[1]
    || 't';
  if (!id) return '';
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=${encodeURIComponent(confirm)}`;
}

async function downloadPdf(url) {
  if (!isAllowedBookUrl(url)) {
    const error = new Error('বইয়ের লিংকটি গ্রহণযোগ্য নয়। পাবলিক https লিংক দিন।');
    error.status = 400;
    throw error;
  }
  const hit = cached(url);
  if (hit) return hit;
  const id = driveFileId(url);
  const candidates = id
    ? [
        `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`,
        `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
        url
      ]
    : [url];
  let lastHtml = '';
  for (const candidate of candidates) {
    const result = await fetchBuffer(candidate);
    if (!result) continue;
    if (looksLikePdf(result.bytes)) {
      remember(url, result.bytes);
      return result.bytes;
    }
    const head = result.bytes.slice(0, 400).toString('utf8').toLowerCase();
    if (head.includes('<html') || head.includes('<!doctype')) {
      lastHtml = result.bytes.toString('utf8');
      const next = confirmLink(lastHtml, candidate);
      if (next) {
        const cookie = result.setCookie.split(/,(?=[^;]+?=)/).map((part) => part.split(';')[0].trim()).filter(Boolean).join('; ');
        const retry = await fetchBuffer(next, cookie);
        if (retry && looksLikePdf(retry.bytes)) {
          remember(url, retry.bytes);
          return retry.bytes;
        }
      }
    }
  }
  const error = new Error('বইয়ের PDF ডাউনলোড করা যায়নি। Google Drive লিংকটি “যে কেউ লিংক দিয়ে দেখতে পারবে” করা আছে কিনা দেখুন।');
  error.status = 422;
  throw error;
}

async function openPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (_) {
    const error = new Error('এই ফাইলটি PDF হিসেবে পড়া যায়নি। সরাসরি PDF লিংক দিন।');
    error.status = 422;
    throw error;
  }
}

async function pdfInfo(url) {
  const bytes = await downloadPdf(url);
  const doc = await openPdf(bytes);
  return { pageCount: Math.min(doc.getPageCount(), MAX_PAGES), bytes: bytes.length, truncated: doc.getPageCount() > MAX_PAGES };
}

async function slicePdf(url, startPage, endPage) {
  const bytes = await downloadPdf(url);
  const doc = await openPdf(bytes);
  const total = doc.getPageCount();
  const start = Math.max(1, Number(startPage) || 1);
  const end = Math.min(total, MAX_PAGES, Number(endPage) || start);
  if (start > total || start > end) {
    const error = new Error('পৃষ্ঠা নম্বর বইয়ের বাইরে।');
    error.status = 400;
    throw error;
  }
  const out = await PDFDocument.create();
  const indexes = [];
  for (let page = start; page <= end; page += 1) indexes.push(page - 1);
  const copied = await out.copyPages(doc, indexes);
  copied.forEach((page) => out.addPage(page));
  const sliced = Buffer.from(await out.save());
  return { bytes: sliced, start, end, pageCount: total };
}

module.exports = { downloadPdf, pdfInfo, slicePdf, MAX_PAGES };
