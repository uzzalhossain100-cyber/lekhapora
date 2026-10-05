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

function textFromGemini(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('\n').trim();
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

async function geminiGenerate(parts, { temperature = 0.2, maxOutputTokens = 2048 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('AI সেবা এখনো কনফিগার করা হয়নি। Vercel-এ GEMINI_API_KEY সেট করা আছে কিনা দেখুন।');
    error.status = 503;
    throw error;
  }
  const configured = process.env.GEMINI_MODEL;
  const models = configured
    ? [configured]
    : ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastError = 'Gemini উত্তর দিতে পারেনি।';
  let lastStatus = 502;
  for (const model of models) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature, maxOutputTokens }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const text = textFromGemini(data);
      if (text) return text;
      lastError = 'Gemini কোনো উত্তর ফেরত দেয়নি।';
      lastStatus = 502;
      continue;
    }
    lastStatus = response.status === 429 ? 429 : 502;
    lastError = response.status === 429
      ? 'Gemini AI এখন ব্যস্ত আছে। এক মিনিট পরে আবার চেষ্টা করুন।'
      : (data?.error?.message || lastError);
    if (![404, 429, 503].includes(response.status)) break;
  }
  const error = new Error(lastError);
  error.status = lastStatus;
  throw error;
}

function weakServerAnswer(answer) {
  const text = String(answer || '').replace(/\s+/g, ' ').trim();
  return text.length < 2 || text.includes('নিশ্চিত উত্তর') || (text.length < 80 && (text.includes('পাওয়া যায়নি') || text.includes('পাওয়া যায়নি')));
}

function pdfPart(bytes) {
  return { inline_data: { mime_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } };
}

function solutionPrompt(className, bookTitle, start, end) {
  return `তুমি বাংলাদেশের একজন অভিজ্ঞ স্কুল শিক্ষক।
শ্রেণী: ${className}
বই: ${bookTitle}
সংযুক্ত PDF-এ এই বইয়ের পৃষ্ঠা ${start} থেকে ${end} আছে।

কাজ:
- শুধু অনুশীলনী, প্রশ্ন, শূন্যস্থান পূরণ, নৈর্ব্যত্তিক বা বহুনির্বাচনি, মিল করো, সত্য-মিথ্যা, বাড়ির কাজ ও অন্যান্য করণীয় কাজ বের করো।
- গল্প, কবিতা বা অধ্যায়ের পুরো পাঠ আলাদা করে কপি করবে না। শুধু প্রশ্ন বা কাজের অংশ হুবহু তুলবে।
- বইয়ে নেই এমন প্রশ্ন নিজে থেকে বানাবে না।
- প্রতিটি প্রশ্নের উত্তর সংযুক্ত সব পাতার পাঠ, গল্প, কবিতা, ছবি বা উদাহরণ থেকে সহজ ভাষায় লিখবে। অনুশীলনীর আগের পাঠও এই পাতায় থাকতে পারে।\n- উত্তর না পেলে answer খালি স্ট্রিং রাখবে। অনিশ্চিত বা ক্ষমাপ্রার্থনামূলক বাক্য লিখবে না।
- এই পৃষ্ঠায় কোনো প্রশ্ন বা কাজ না থাকলে খালি তালিকা দাও।

শুধু JSON দাও:
{"items":[{"page":${start},"chapter":"অধ্যায়ের নাম","type":"অনুশীলনী","question":"প্রশ্ন হুবহু","answer":"সঠিক উত্তর"}]}`;
}

function answerPrompt(className, bookTitle, question, paged) {
  return `তুমি বাংলাদেশের স্কুল শিক্ষক।
শ্রেণী: ${className}
নির্বাচিত বই: ${bookTitle}
শিক্ষার্থীর প্রশ্ন: ${question}

সংযুক্ত ${paged ? 'পৃষ্ঠাগুলো' : 'বই'} থেকে এই প্রশ্নের সঠিক উত্তর দাও।
- বইয়ের বাইরের তথ্য দিয়ে অনুমান করবে না।
- উত্তর সহজ ও বয়স-উপযোগী হবে।
- এই অংশে উত্তর না থাকলে found=false দাও।
শুধু JSON দাও:
{"found":false,"answer":""}`;
}

async function solvePdfPages({ bytes, className, bookTitle, startPage, endPage }) {
  const text = await geminiGenerate([
    pdfPart(bytes),
    { text: solutionPrompt(className, bookTitle, startPage, endPage) }
  ], { temperature: 0.15, maxOutputTokens: 4096 });
  const parsed = parseJsonLoose(text);
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  return list.map((item) => {
    const question = String(item.question || '').trim();
    const answer = String(item.answer || '').trim();
    if (question.length < 2) return null;
    const usable = weakServerAnswer(answer) ? '' : answer;
    return {
      page: Math.max(startPage, Math.min(endPage, Number(item.page) || startPage)),
      chapter: String(item.chapter || `পৃষ্ঠা ${startPage}`).trim().slice(0, 180),
      type: String(item.type || 'অনুশীলনী').trim().slice(0, 40),
      question: question.slice(0, 2000),
      answer: usable.slice(0, 4000)
    };
  }).filter(Boolean);
}

async function answerFromPdf({ bytes, className, bookTitle, question, paged }) {
  const text = await geminiGenerate([
    pdfPart(bytes),
    { text: answerPrompt(className, bookTitle, question, paged) }
  ], { temperature: 0.2, maxOutputTokens: 900 });
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object') {
    return { found: false, answer: '' };
  }
  const answer = String(parsed.answer || '').trim();
  return { found: parsed.found === true && Boolean(answer), answer };
}


function fillPrompt(className, bookTitle, start, end, questions) {
  const lines = questions.map((item, index) => (index + 1) + '. ' + item).join('\n');
  return `তুমি বাংলাদেশের একজন অভিজ্ঞ স্কুল শিক্ষক।
শ্রেণী: ${className}
বই: ${bookTitle}
সংযুক্ত PDF-এ পৃষ্ঠা ${start} থেকে ${end} আছে। স্ক্যান করা পাতা হলে ছবি পড়ে উত্তর দাও।

নিচের প্রতিটি প্রশ্নের উত্তর শুধু এই পাতাগুলোর পাঠ, গল্প, কবিতা, ছবি বা উদাহরণ থেকে দাও।
- বইয়ের বাইরের তথ্য দিয়ে উত্তর বানাবে না।
- অনিশ্চিত বা ক্ষমাপ্রার্থনামূলক বাক্য লিখবে না।
- উত্তর না পেলে সেই প্রশ্ন JSON-এ রাখবে না।
- question ফিল্ডে প্রশ্নটি হুবহু কপি করবে।

প্রশ্ন:
${lines}

শুধু JSON দাও:
{"items":[{"question":"প্রশ্ন হুবহু","answer":"বই থেকে সংক্ষিপ্ত সঠিক উত্তর"}]}`;
}

async function fillPdfPages({ bytes, className, bookTitle, startPage, endPage, questions }) {
  const text = await geminiGenerate([
    pdfPart(bytes),
    { text: fillPrompt(className, bookTitle, startPage, endPage, questions) }
  ], { temperature: 0.15, maxOutputTokens: 4096 });
  const parsed = parseJsonLoose(text);
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  return list.map((item) => {
    const question = String(item.question || '').trim();
    const answer = String(item.answer || '').trim();
    if (question.length < 2 || weakServerAnswer(answer)) return null;
    return { question: question.slice(0, 2000), answer: answer.slice(0, 4000) };
  }).filter(Boolean);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Only POST requests are allowed.' });
  }
  try {
    if (!readSession(req)) return send(res, 401, { error: 'সমাধান তৈরি করতে আগে এডমিন লগইন করুন।' });
    const body = await readBody(req);
    const bytes = Buffer.from(String(body.pdfBase64 || ''), 'base64');
    if (bytes.length < 100 || bytes.length > 4 * 1024 * 1024 || bytes.slice(0, 4).toString() !== '%PDF') {
      return send(res, 400, { error: 'পৃষ্ঠার ফাইলটি পড়া যায়নি। আবার চেষ্টা করুন।' });
    }
    const className = String(body.className || 'শ্রেণী').slice(0, 60);
    const bookTitle = String(body.bookTitle || 'বই').slice(0, 80);
    const startPage = Math.max(1, Number(body.startPage) || 1);
    const endPage = Math.max(startPage, Number(body.endPage) || startPage);
    const questions = Array.isArray(body.questions)
      ? body.questions.map((item) => String((item && item.question) || item || '').trim()).filter((item) => item.length > 1).slice(0, 8)
      : [];
    if (questions.length) {
      const items = await fillPdfPages({ bytes, className, bookTitle, startPage, endPage, questions });
      return send(res, 200, { items: items, fill: true });
    }
    const items = await solvePdfPages({ bytes, className, bookTitle, startPage, endPage });
    return send(res, 200, { items: items });
  } catch (error) {
    return send(res, error.status || 502, { error: error.message || 'সমাধান তৈরি করা যায়নি।' });
  }
};
