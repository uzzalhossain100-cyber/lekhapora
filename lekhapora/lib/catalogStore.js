const fs = require('fs');
const path = require('path');
const { isAllowedBookUrl, previewFromLink } = require('./urls');

const REPO = process.env.GITHUB_REPO || 'uzzalhossain100-cyber/lekhapora';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'data/catalog.json';
const LOCAL_FILE = path.join(__dirname, '..', FILE_PATH);
const bundledSeed = require('../data/catalog.json');
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
    return bundledSeed;
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

module.exports = { loadCatalog, saveCatalog, sanitizeCatalog, canPersist, emptyCatalog };
