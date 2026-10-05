'use strict';
const crypto = require('crypto');

const DEFAULT_ADMIN_ID = 'Uzzal';
const DEFAULT_PASSWORD_HASH = 'fc949fd65dfe32c5331ed7bb9d1aac30e9c0eeee1400c0345c44183dc70887d6';
const COOKIE = 'amarboi_admin';
const MAX_PDF = 32 * 1024 * 1024;
const hits = new Map();

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length) return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return req.body && typeof req.body === 'object' ? req.body : {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return {}; }
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
function limited(ip) {
  const now = Date.now();
  const row = hits.get(ip) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (row.reset < now) { row.count = 0; row.reset = now + 10 * 60 * 1000; }
  row.count += 1;
  hits.set(ip, row);
  return row.count > 240;
}
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest(); }
function safeEqual(left, right) { return crypto.timingSafeEqual(digest(left), digest(right)); }
function adminId() { return String(process.env.ADMIN_ID || DEFAULT_ADMIN_ID).trim() || DEFAULT_ADMIN_ID; }
function sessionSecret() { return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD_HASH; }
function readSession(req) {
  const part = String(req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(COOKIE + '='));
  if (!part) return null;
  let raw = part.slice(COOKIE.length + 1);
  try { raw = decodeURIComponent(raw); } catch (_) {}
  const bits = raw.split('|');
  if (bits.length !== 3) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(bits[0] + '|' + bits[1]).digest('hex');
  if (!safeEqual(bits[2], expected)) return null;
  if (Number(bits[1]) < Date.now()) return null;
  if (!safeEqual(bits[0], adminId())) return null;
  return { id: adminId() };
}
function isPrivateIp(host) {
  const match = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const a = parts[0];
  const b = parts[1];
  return a === 10 || a === 127 || a === 0 || a === 255 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
function assertPublicUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { throw Object.assign(new Error('সঠিক https লিংক দিন।'), { status: 400 }); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Object.assign(new Error('শুধু ওয়েব লিংক দেওয়া যাবে।'), { status: 400 });
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || isPrivateIp(host)) {
    throw Object.assign(new Error('এই লিংকটি নিরাপদ নয়।'), { status: 400 });
  }
  return url.toString();
}
function driveId(value) {
  const file = String(value).match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || String(value).match(/docs\.google\.com\/(?:document|file)\/d\/([^/?#]+)/);
  if (file) return file[1];
  const id = String(value).match(/[?&]id=([^&#]+)/);
  return id && /google\.com|googleusercontent\.com/.test(value) ? id[1] : '';
}
function candidateUrls(raw) {
  const url = assertPublicUrl(raw);
  const doc = url.match(/docs\.google\.com\/document\/d\/([^/?#]+)/);
  if (doc) return ['https://docs.google.com/document/d/' + doc[1] + '/export?format=txt', url];
  const id = driveId(url);
  if (!id) return [url];
  return [
    'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t',
    'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id),
    url
  ];
}
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
function pageTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 120) : '';
}
function looksPdf(buf) { return buf && buf.length > 4 && buf.slice(0, 4).toString() === '%PDF'; }
function countPdfPages(buf) {
  const raw = buf.toString('latin1');
  const pages = raw.match(/\/Type\s*\/Page(?!s)/g);
  if (pages && pages.length) return Math.min(pages.length, 220);
  const count = raw.match(/\/Count\s+(\d+)/);
  return count ? Math.min(Number(count[1]) || 0, 220) : 0;
}
async function readLimited(response, max) {
  if (!response.body || !response.body.getReader) return Buffer.from(await response.arrayBuffer()).slice(0, max);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < max) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(Buffer.from(step.value));
    total += step.value.length;
  }
  try { await reader.cancel(); } catch (_) {}
  return Buffer.concat(chunks).slice(0, max);
}
async function fetchOne(url, max) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmarBoi/1.0)', Accept: 'application/pdf,text/html,text/plain,*/*' }
    });
    if (!response.ok) return null;
    try { assertPublicUrl(response.url || url); } catch (_) { return null; }
    const buf = await readLimited(response, max);
    return { buf, type: response.headers.get('content-type') || '', finalUrl: response.url || url };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function confirmUrl(html, current) {
  const id = driveId(current) || (String(html).match(/name="id"\s+value="([^"]+)"/) || [])[1] || '';
  const confirm = (String(html).match(/confirm=([0-9A-Za-z_-]+)/) || [])[1] || 't';
  return id ? 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=' + encodeURIComponent(confirm) : '';
}
function sameSiteLinks(html, base) {
  let host = '';
  try { host = new URL(base).hostname; } catch (_) { return []; }
  const found = [];
  const seen = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = re.exec(String(html))) && found.length < 12) {
    let href;
    try { href = new URL(match[1], base); } catch (_) { continue; }
    if (href.hostname !== host || (href.protocol !== 'https:' && href.protocol !== 'http:')) continue;
    const path = href.pathname.toLowerCase();
    if (/(login|signin|signup|cart|account|wp-admin|facebook|twitter|share)/.test(path + href.search)) continue;
    if (/\.(jpg|jpeg|png|gif|css|js|svg|zip|mp3|mp4|woff2?)$/.test(path)) continue;
    const key = href.origin + href.pathname;
    if (seen.has(key) || key === new URL(base).origin + new URL(base).pathname) continue;
    seen.add(key);
    found.push(href.toString());
  }
  return found;
}
async function expandShortPage(html, pageUrl, plain) {
  if (plain.length >= 2500) return plain;
  const extra = [];
  for (const link of sameSiteLinks(html, pageUrl)) {
    const result = await fetchOne(link, 1500000);
    if (!result || looksPdf(result.buf)) continue;
    const text = htmlToText(result.buf.toString('utf8'));
    if (text.length > 180) extra.push(text);
    if ((plain.length + extra.join('\n').length) > 160000) break;
  }
  return [plain].concat(extra).join('\n\n');
}
async function loadSource(raw) {
  const urls = candidateUrls(raw);
  let lastHtml = '';
  for (const url of urls) {
    const result = await fetchOne(url, MAX_PDF);
    if (!result) continue;
    if (looksPdf(result.buf)) return { kind: 'pdf', bytes: result.buf, pageCount: countPdfPages(result.buf) || 40 };
    const head = result.buf.slice(0, 300).toString('utf8').toLowerCase();
    const text = result.buf.toString('utf8');
    if (head.includes('<html') || head.includes('<!doctype') || (result.type.includes('html'))) {
      lastHtml = text;
      const next = confirmUrl(text, url);
      if (next && next !== url) {
        const retry = await fetchOne(next, MAX_PDF);
        if (retry && looksPdf(retry.buf)) return { kind: 'pdf', bytes: retry.buf, pageCount: countPdfPages(retry.buf) || 40 };
        if (retry) lastHtml = retry.buf.toString('utf8');
      }
      let plain = htmlToText(lastHtml);
      if (plain.length > 80) {
        plain = await expandShortPage(lastHtml, result.finalUrl || url, plain);
        return { kind: 'html', text: plain.slice(0, 240000), title: pageTitle(lastHtml), links: sameSiteLinks(lastHtml, result.finalUrl || url).slice(0, 8) };
      }
    } else if (text.trim().length > 80) {
      return { kind: 'html', text: text.trim().slice(0, 240000), title: '' };
    }
  }
  throw Object.assign(new Error('এই লিংক থেকে বই পড়া যায়নি। লিংকটি সবার জন্য খোলা আছে কিনা দেখুন। লগইন-ওয়ালা বা স্ক্যান করা সাইট হলে AI পড়তে পারে না।'), { status: 422 });
}
function chunksOf(text) {
  const size = 7000;
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 36; i += size - 400) chunks.push(text.slice(i, i + size));
  return chunks;
}
function questionTerms(question) {
  return String(question || '').split(/\s+/).map((word) => word.trim()).filter((word) => word.length > 1).slice(0, 12);
}
function scoreText(text, terms) {
  return terms.reduce((sum, term) => sum + (String(text).includes(term) ? 1 : 0), 0);
}
function textWindows(text, question) {
  const full = String(text || '');
  const terms = questionTerms(question);
  const size = 11000;
  const windows = [];
  for (let i = 0; i < full.length && windows.length < 12; i += size - 600) windows.push(full.slice(i, i + size));
  return windows.sort((a, b) => scoreText(b, terms) - scoreText(a, terms));
}
function relevantText(text, question) {
  return textWindows(text, question).slice(0, 2).join('\n\n').slice(0, 22000) || String(text || '').slice(0, 22000);
}
function parseJsonLoose(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const start = trimmed.search(/[\[{]/);
  const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}
function interpretAnswer(raw) {
  const parsed = parseJsonLoose(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const answer = String(parsed.answer || '').trim();
    if (parsed.found === false && answer.length < 30) return { found: false, answer: '' };
    if (answer.length > 8) return { found: true, answer: answer.slice(0, 4000) };
  }
  const text = String(raw || '').trim();
  if (text.length > 25) return { found: true, answer: text.slice(0, 4000) };
  return { found: false, answer: '' };
}
async function gemini(parts, maxOutputTokens, extra) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Vercel-এ GEMINI_API_KEY সেট করা নেই, তাই AI বই পড়তে পারছে না।'), { status: 503 });
  const models = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  let last = 'Gemini উত্তর দিতে পারেনি।';
  for (const model of models) {
    const payload = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, maxOutputTokens: maxOutputTokens || 1200 } };
    if (extra) Object.assign(payload, extra);
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n').trim();
      if (text) return text;
    }
    last = response.status === 429 ? 'Gemini এখন ব্যস্ত। এক মিনিট পরে আবার চেষ্টা করুন।' : (data.error?.message || last);
    if (extra && response.status === 400) continue;
    if (![404, 429, 503].includes(response.status)) break;
  }
  throw Object.assign(new Error(last), { status: 502 });
}
async function answerByUrlContext(urls, question, bookTitle, className) {
  const list = urls.filter(Boolean).slice(0, 8);
  if (!list.length) return { found: false, answer: '' };
  const prompt = 'তুমি বাংলাদেশের স্কুল শিক্ষক। শ্রেণী: ' + className + '। বই: ' + bookTitle + '।\nশিক্ষার্থীর প্রশ্ন: ' + question + '\nনিচের লিংকগুলো খুলে বই বা সাইটের পাঠ পড়ে উত্তর দাও। উত্তর ওই লেখার ওপর ভিত্তি করে দাও। বিষয়টি পাঠে থাকলে found=true। একেবারে না থাকলে found=false। নিজের মন থেকে গল্প বানিয়ে উত্তর দিবে না।\nলিংক:\n' + list.join('\n') + '\nশুধু JSON: {"found":true,"answer":"উত্তর"}';
  try {
    return interpretAnswer(await gemini([{ text: prompt }], 1400, { tools: [{ url_context: {} }] }));
  } catch (_) {
    return { found: false, answer: '' };
  }
}
async function uploadPdf(bytes) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Vercel-এ GEMINI_API_KEY সেট করা নেই।'), { status: 503 });
  if (bytes.length <= 6 * 1024 * 1024) return { inline: true, bytes };
  const boundary = 'amarboi' + Date.now();
  const meta = JSON.stringify({ file: { display_name: 'amarboi-book' } });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: application/pdf\r\n\r\n'),
    bytes,
    Buffer.from('\r\n--' + boundary + '--')
  ]);
  const response = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary, 'X-Goog-Upload-Protocol': 'multipart' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.file) throw Object.assign(new Error(data.error?.message || 'বড় PDF AI-তে পাঠানো যায়নি।'), { status: 502 });
  let file = data.file;
  for (let i = 0; i < 6 && file.state && file.state !== 'ACTIVE'; i += 1) {
    if (file.state === 'FAILED') throw Object.assign(new Error('AI এই PDF পড়তে পারেনি।'), { status: 422 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const check = await fetch('https://generativelanguage.googleapis.com/v1beta/' + file.name + '?key=' + encodeURIComponent(apiKey));
    file = await check.json();
  }
  return { inline: false, fileUri: file.uri, mimeType: file.mimeType || 'application/pdf' };
}
function pdfParts(prepared, extraText) {
  if (prepared.inline) return [{ inline_data: { mime_type: 'application/pdf', data: prepared.bytes.toString('base64') } }, { text: extraText }];
  return [{ file_data: { mime_type: prepared.mimeType || 'application/pdf', file_uri: prepared.fileUri } }, { text: extraText }];
}
function cleanItems(raw, fallbackPage) {
  const parsed = typeof raw === 'string' ? parseJsonLoose(raw) : raw;
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  return list.map((item) => {
    const question = String(item.question || '').trim();
    const answer = String(item.answer || '').trim();
    if (question.length < 2 || !answer) return null;
    return {
      page: Number(item.page) || fallbackPage || 0,
      chapter: String(item.chapter || 'অনুশীলনী').slice(0, 180),
      type: String(item.type || 'অনুশীলনী').slice(0, 40),
      question: question.slice(0, 2000),
      answer: answer.slice(0, 4000)
    };
  }).filter(Boolean);
}
const sourceCache = new Map();
function remember(url, source) {
  sourceCache.set(url, { source, at: Date.now() });
  if (sourceCache.size > 2) sourceCache.delete(sourceCache.keys().next().value);
}
async function cachedSource(url) {
  const hit = sourceCache.get(url);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.source;
  const source = await loadSource(url);
  remember(url, source);
  return source;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Only POST requests are allowed.' });
  try {
    if (limited(clientIp(req))) return send(res, 429, { error: 'একসাথে অনেক অনুরোধ হয়েছে। একটু পরে চেষ্টা করুন।' });
    const body = await readBody(req);
    const action = String(body.action || 'probe');
    const admin = readSession(req);
    if (action !== 'answer' && !admin) return send(res, 401, { error: 'আগে এডমিন লগইন করুন।' });
    const url = assertPublicUrl(body.url || '');
    if (action === 'probe') {
      const source = await cachedSource(url);
      const chars = source.text ? source.text.length : 0;
      const preview = source.kind === 'html' ? source.text.replace(/\s+/g, ' ').slice(0, 180) : '';
      const weak = source.kind === 'html' && chars < 400;
      const message = source.kind === 'pdf'
        ? 'PDF পাওয়া গেছে। AI এই বই পড়ে উত্তর দিতে পারবে।'
        : weak
          ? 'লিংক খোলা গেছে, কিন্তু পড়ার মতো লেখা খুব কম। বইয়ের যে পাতায় পাঠ বা অনুশীলনী আছে সেই লিংক দিন। লগইন-ওয়ালা সাইট পড়া যায় না।'
          : 'সাইটের লেখা পাওয়া গেছে। AI এই লিংক থেকে উত্তর দিতে পারবে।';
      return send(res, 200, { ok: !weak, kind: source.kind, pages: source.pageCount || 0, chars, title: source.title || '', preview, message });
    }
    const bookTitle = String(body.bookTitle || 'বই').slice(0, 80);
    const className = String(body.className || 'শ্রেণী').slice(0, 60);
    if (action === 'prepare') {
      const source = await cachedSource(url);
      if (source.kind === 'html') {
        const chunks = chunksOf(source.text);
        return send(res, 200, { kind: 'html', chunks, title: source.title || bookTitle });
      }
      const uploaded = await uploadPdf(source.bytes);
      return send(res, 200, {
        kind: 'pdf',
        inline: uploaded.inline,
        fileUri: uploaded.fileUri || '',
        mimeType: uploaded.mimeType || 'application/pdf',
        pageCount: source.pageCount || 40,
        title: bookTitle
      });
    }
    if (action === 'solve-text') {
      const text = String(body.text || '').slice(0, 9000);
      if (text.length < 40) return send(res, 200, { items: [] });
      const prompt = 'তুমি বাংলাদেশের স্কুল শিক্ষক। শ্রেণী: ' + className + '। বই: ' + bookTitle + '।\nনিচের পাঠ থেকে শুধু অনুশীলনী, প্রশ্ন, শূন্যস্থান, নৈর্ব্যত্তিক, মিলকরণ ও বাড়ির কাজ বের করো। গল্প বা কবিতার পুরো পাঠ কপি করবে না। প্রশ্ন হুবহু তুলবে এবং বইয়ের তথ্য থেকে উত্তর দেবে। প্রশ্ন না থাকলে items খালি রাখবে। শুধু JSON দাও:\n{"items":[{"page":1,"chapter":"অধ্যায়","type":"অনুশীলনী","question":"প্রশ্ন","answer":"উত্তর"}]}\n\nপাঠ:\n' + text;
      const raw = await gemini([{ text: prompt }], 4096);
      return send(res, 200, { items: cleanItems(raw, Number(body.part) || 1) });
    }
    if (action === 'solve-pdf') {
      const uploaded = body.fileUri
        ? { inline: false, fileUri: String(body.fileUri), mimeType: String(body.mimeType || 'application/pdf') }
        : await (async () => {
          const source = await cachedSource(url);
          if (source.kind !== 'pdf') throw Object.assign(new Error('এটি PDF নয়।'), { status: 400 });
          return uploadPdf(source.bytes);
        })();
      const startPage = Math.max(1, Number(body.startPage) || 1);
      const endPage = Math.max(startPage, Number(body.endPage) || startPage);
      const prompt = 'তুমি বাংলাদেশের স্কুল শিক্ষক। শ্রেণী: ' + className + '। বই: ' + bookTitle + '।\nসংযুক্ত PDF-এর পৃষ্ঠা ' + startPage + ' থেকে ' + endPage + ' দেখো। শুধু অনুশীলনী, প্রশ্ন, শূন্যস্থান, নৈর্ব্যত্তিক ও বাড়ির কাজ হুবহু তুলে উত্তর দাও। পুরো অধ্যায়ের গল্প কপি করবে না। প্রশ্ন না থাকলে খালি তালিকা দাও। শুধু JSON:\n{"items":[{"page":' + startPage + ',"chapter":"অধ্যায়","type":"অনুশীলনী","question":"প্রশ্ন","answer":"উত্তর"}]}';
      const raw = await gemini(pdfParts(uploaded, prompt), 4096);
      return send(res, 200, { items: cleanItems(raw, startPage) });
    }
    const question = String(body.question || '').trim().slice(0, 1200);
    if (!question) return send(res, 400, { error: 'প্রশ্ন লিখুন।' });
    const source = await cachedSource(url);
    if (source.kind === 'html') {
      const pageUrls = [url].concat(source.links || []).filter((item, index, list) => list.indexOf(item) === index).slice(0, 8);
      let result = await answerByUrlContext(pageUrls, question, bookTitle, className);
      if (!result.found) {
        const windows = textWindows(source.text, question);
        for (let i = 0; i < windows.length && i < 3 && !result.found; i += 1) {
          const prompt = 'তুমি বাংলাদেশের স্কুল শিক্ষক। শ্রেণী: ' + className + '। বই: ' + bookTitle + '।\nশিক্ষার্থীর প্রশ্ন: ' + question + '\nনিচের পাঠ থেকে উত্তর দাও। বিষয়টি পাঠে থাকলে found=true। একেবারে না থাকলে found=false। নিজের মন থেকে উত্তর বানাবে না। শুধু JSON: {"found":true,"answer":"উত্তর"}\n\nপাঠ:\n' + windows[i];
          try { result = interpretAnswer(await gemini([{ text: prompt }], 1200)); } catch (_) {}
        }
      }
      if (!result.found) return send(res, 200, { found: false, answer: '', error: 'এই লিংকের পাঠে প্রশ্নের উত্তর পাওয়া যায়নি। বইয়ের যে পাতায় পাঠ আছে সেই লিংক দিন।' });
      return send(res, 200, result);
    }
    const uploaded = await uploadPdf(source.bytes);
    const pdfPrompt = 'তুমি বাংলাদেশের স্কুল শিক্ষক। শ্রেণী: ' + className + '। বই: ' + bookTitle + '।\nশিক্ষার্থীর প্রশ্ন: ' + question + '\nসংযুক্ত বই পড়ে উত্তর দাও। বিষয়টি বইয়ে থাকলে found=true। একেবারে না থাকলে found=false। নিজের মন থেকে উত্তর বানাবে না। শুধু JSON: {"found":true,"answer":"উত্তর"}';
    const result = interpretAnswer(await gemini(pdfParts(uploaded, pdfPrompt), 1400));
    if (!result.found) return send(res, 200, { found: false, answer: '', error: 'এই PDF-এ প্রশ্নের উত্তর পাওয়া যায়নি।' });
    return send(res, 200, result);
  } catch (error) {
    return send(res, error.status || 502, { error: error.message || 'বই পড়া যায়নি।' });
  }
};
module.exports.config = { maxDuration: 60 };
