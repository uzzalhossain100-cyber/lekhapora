'use strict';
const crypto = require('crypto');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Only POST requests are allowed.' });
  }
  clearSessionCookie(req, res);
  return send(res, 200, { ok: true });
};
