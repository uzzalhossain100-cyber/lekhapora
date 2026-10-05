'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Object.keys(req.body).length || req.body.catalog || req.body.question || req.body.id || req.body.action) return req.body;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  if (Buffer.isBuffer(req.body) && req.body.length) {
    try { return JSON.parse(req.body.toString('utf8')); } catch (_) { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return {}; }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

const DEFAULT_ADMIN_ID = 'Uzzal';
const DEFAULT_PASSWORD_HASH = 'fc949fd65dfe32c5331ed7bb9d1aac30e9c0eeee1400c0345c44183dc70887d6';
const COOKIE = 'amarboi_admin';

function adminId() {
  return String(process.env.ADMIN_ID || DEFAULT_ADMIN_ID).trim() || DEFAULT_ADMIN_ID;
}

function sessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD_HASH;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function passwordOk(id, password) {
  const expectedId = adminId();
  if (!safeEqual(String(id || '').trim(), expectedId)) return false;
  if (process.env.ADMIN_PASSWORD) return safeEqual(password, process.env.ADMIN_PASSWORD);
  if (expectedId !== DEFAULT_ADMIN_ID) return false;
  const hash = crypto.createHash('sha256').update(`AmarBoi|${DEFAULT_ADMIN_ID}|${password}`).digest('hex');
  return safeEqual(hash, DEFAULT_PASSWORD_HASH);
}

function signSession(id) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = `${id}|${exp}`;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}|${sig}`;
}

function readSession(req) {
  const cookie = String(req.headers.cookie || '');
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE}=`));
  if (!part) return null;
  let raw = part.slice(COOKIE.length + 1);
  try { raw = decodeURIComponent(raw); } catch (_) {}
  const parts = raw.split('|');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(`${id}|${exp}`).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return null;
  if (!safeEqual(id, adminId())) return null;
  return { id: adminId() };
}

function cookieFlags(req, maxAge) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const host = String(req.headers.host || '');
  const secure = proto === 'https' || process.env.VERCEL === '1' || host.endsWith('.vercel.app');
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function setSessionCookie(req, res, id) {
  const token = encodeURIComponent(signSession(id));
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags(req, 7 * 24 * 60 * 60)}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req, 0)}`);
}

const attempts = new Map();
function loginBlocked(ip) {
  const row = attempts.get(ip);
  return Boolean(row && row.reset > Date.now() && row.count > 8);
}
function registerLoginFailure(ip) {
  const now = Date.now();
  const row = attempts.get(ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (row.reset < now) {
    row.count = 0;
    row.reset = now + 15 * 60 * 1000;
  }
  row.count += 1;
  attempts.set(ip, row);
  return row.count > 8;
}
function clearLoginFailures(ip) {
  attempts.delete(ip);
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.google.com']);

function isPrivateIp(host) {
  const match = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isAllowedBookUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  if (host.includes(':') || isPrivateIp(host)) return false;
  return true;
}

function driveFileId(value) {
  const url = String(value || '');
  const file = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (file) return file[1];
  const id = url.match(/[?&]id=([^&#]+)/);
  if (id && /google\.com|googleusercontent\.com/.test(url)) return id[1];
  return '';
}

function previewFromLink(link) {
  const id = driveFileId(link);
  if (id) return `https://drive.google.com/file/d/${id}/preview`;
  return String(link || '');
}

const REPO = process.env.GITHUB_REPO || 'uzzalhossain100-cyber/lekhapora';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'data/catalog.json';
const LOCAL_FILE = path.join(__dirname, '..', FILE_PATH);
const BUILTIN_BOOK_IDS = new Set(['bangla', 'bangladesh', 'science', 'islam', 'math', 'english']);

function emptyCatalog() {
  return { version: 1, updatedAt: '', classes: [], books: [], solutions: {} };
}

function stripControls(value) {
  return Array.from(String(value || '')).filter((ch) => {
    const code = ch.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || code >= 32;
  }).join('');
}

function cleanPlain(value, max) {
  return stripControls(value).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

function cleanRich(value, max) {
  const withBreaks = String(value || '').replace(/<br\s*\/?>/gi, '\n');
  const noTags = withBreaks.replace(/<[^>]*>/g, '');
  const decoded = noTags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  const clipped = stripControls(decoded).trim().slice(0, max);
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

function sanitizeCatalog(input, stamp = false) {
  const source = input && typeof input === 'object' ? input : {};
  const classes = [];
  const seenClass = new Set();
  for (const item of Array.isArray(source.classes) ? source.classes.slice(0, 40) : []) {
    const id = cleanPlain(item.id, 40);
    const name = cleanPlain(item.name, 60);
    if (!/^c-[a-z0-9]+$/i.test(id) || !name || seenClass.has(id) || seenClass.has(name)) continue;
    seenClass.add(id);
    seenClass.add(name);
    classes.push({ id, name, createdAt: cleanPlain(item.createdAt, 40) });
  }
  const classIds = new Set(classes.map((item) => item.id).concat('class-3'));
  const books = [];
  const seenBook = new Set();
  for (const item of Array.isArray(source.books) ? source.books.slice(0, 240) : []) {
    const id = cleanPlain(item.id, 40);
    const classId = cleanPlain(item.classId, 40);
    const title = cleanPlain(item.title, 80);
    const link = cleanPlain(item.link, 600);
    if (!/^b-[a-z0-9]+$/i.test(id) || BUILTIN_BOOK_IDS.has(id) || !classIds.has(classId) || !title) continue;
    if (seenBook.has(`${classId}|${title}`) || seenBook.has(id)) continue;
    if (link && !isAllowedBookUrl(link)) continue;
    seenBook.add(id);
    seenBook.add(`${classId}|${title}`);
    books.push({
      id,
      classId,
      title,
      icon: cleanPlain(item.icon, 8) || '📘',
      link,
      preview: link ? previewFromLink(link) : '',
      published: Boolean(link),
      createdAt: cleanPlain(item.createdAt, 40)
    });
  }
  const bookIds = new Set(books.map((item) => item.id).concat([...BUILTIN_BOOK_IDS]));
  const solutions = {};
  const sourceSolutions = source.solutions && typeof source.solutions === 'object' ? source.solutions : {};
  for (const bookId of Object.keys(sourceSolutions).slice(0, 240)) {
    const id = cleanPlain(bookId, 40);
    if (!bookIds.has(id) || !Array.isArray(sourceSolutions[bookId])) continue;
    const records = [];
    sourceSolutions[bookId].slice(0, 2500).forEach((item, index) => {
      const question = cleanRich(item.t || item.question, 2500);
      const answer = cleanRich(item.a || item.answer, 5000);
      if (!question || !answer) return;
      records.push({
        p: Math.max(0, Math.min(2000, Number(item.p || item.page) || 0)),
        l: cleanRich(item.l || item.chapter || 'অনুশীলনী', 180),
        q: cleanPlain(item.q || String(index + 1), 20) || String(index + 1),
        t: question,
        a: answer,
        type: cleanPlain(item.type, 40) || 'অনুশীলনী'
      });
    });
    if (records.length) solutions[id] = records;
  }
  return {
    version: 1,
    updatedAt: stamp ? new Date().toISOString() : cleanPlain(source.updatedAt, 40),
    classes,
    books,
    solutions
  };
}

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  } catch (_) {
    return emptyCatalog();
  }
}

function newer(left, right) {
  const a = Date.parse(left?.updatedAt || '') || 0;
  const b = Date.parse(right?.updatedAt || '') || 0;
  return b > a ? right : left;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AmarBoi',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

async function readRemote() {
  const token = githubToken();
  try {
    if (token) {
      const response = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${encodeURIComponent(BRANCH)}`, {
        headers: githubHeaders(token)
      });
      if (!response.ok) return null;
      const data = await response.json();
      return JSON.parse(Buffer.from(data.content || '', 'base64').toString('utf8'));
    }
    const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE_PATH}?t=${Date.now()}`, {
      headers: { 'User-Agent': 'AmarBoi', Accept: 'application/json' }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function loadCatalog() {
  const local = sanitizeCatalog(readLocal());
  const remote = await readRemote();
  return remote ? sanitizeCatalog(newer(local, remote)) : local;
}

function canPersist() {
  return Boolean(githubToken()) || process.env.VERCEL !== '1';
}

async function saveCatalog(input) {
  const catalog = sanitizeCatalog(input, true);
  const token = githubToken();
  if (token) {
    const api = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
    const headers = githubHeaders(token);
    const current = await fetch(`${api}?ref=${encodeURIComponent(BRANCH)}`, { headers });
    let sha = '';
    if (current.ok) sha = (await current.json()).sha || '';
    else if (current.status !== 404) {
      const error = await current.json().catch(() => ({}));
      throw new Error(error.message || 'GitHub থেকে ক্যাটালগ পড়া যায়নি।');
    }
    const body = {
      message: 'Update AmarBoi class, book and solution catalog',
      content: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`).toString('base64'),
      branch: BRANCH
    };
    if (sha) body.sha = sha;
    const put = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!put.ok) {
      const error = await put.json().catch(() => ({}));
      throw new Error(error.message || 'GitHub-এ সেভ করা যায়নি। টোকেনে repo লেখার অনুমতি আছে কিনা দেখুন।');
    }
    return { catalog, persisted: true, via: 'github' };
  }
  if (process.env.VERCEL === '1') {
    return { catalog, persisted: false, via: 'none' };
  }
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalog, persisted: true, via: 'file' };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const catalog = await loadCatalog();
      return send(res, 200, { catalog: catalog, canPersist: canPersist() });
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
