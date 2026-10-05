'use strict';


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
- প্রতিটি প্রশ্নের সঠিক উত্তর বইয়ের পাঠ অনুসারে সহজ ভাষায় লিখবে। উত্তর নিশ্চিত না হলে উত্তরে লিখবে: বইয়ের এই পৃষ্ঠা থেকে নিশ্চিত উত্তর পাওয়া যায়নি।
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
    if (question.length < 2 || answer.length < 1) return null;
    return {
      page: Math.max(startPage, Math.min(endPage, Number(item.page) || startPage)),
      chapter: String(item.chapter || `পৃষ্ঠা ${startPage}`).trim().slice(0, 180),
      type: String(item.type || 'অনুশীলনী').trim().slice(0, 40),
      question: question.slice(0, 2000),
      answer: answer.slice(0, 4000)
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
    const question = String(body.question || '').trim().slice(0, 1200);
    if (!question) return send(res, 400, { error: 'প্রশ্ন লিখুন।' });
    const bytes = Buffer.from(String(body.pdfBase64 || ''), 'base64');
    if (bytes.length < 100 || bytes.length > 4 * 1024 * 1024 || bytes.slice(0, 4).toString() !== '%PDF') {
      return send(res, 400, { error: 'বইয়ের পৃষ্ঠা পড়া যায়নি।' });
    }
    const result = await answerFromPdf({
      bytes: bytes,
      className: String(body.className || 'শ্রেণী').slice(0, 60),
      bookTitle: String(body.bookTitle || 'নির্বাচিত বই').slice(0, 80),
      question: question,
      paged: true
    });
    return send(res, 200, result);
  } catch (error) {
    return send(res, error.status || 502, { error: error.message || 'বই থেকে উত্তর তৈরি করা যায়নি।' });
  }
};
