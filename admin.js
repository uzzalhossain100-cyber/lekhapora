(function () {
  if (typeof window === 'undefined' || typeof startSchoolApp !== 'function') return;

  const BUILTIN_IDS = new Set(['bangla', 'bangladesh', 'science', 'islam', 'math', 'english']);
  const PENDING_KEY = 'AmarBoi-admin-catalog-pending-v1';
  const LOCAL_KEY = 'AmarBoi-catalog-local-v1';
  const JOB_KEY = 'AmarBoi-solution-job-v1';
  const ICONS = ['📘', '📗', '📙', '📕', '📔', '📓', '📚', '✏️'];
  const ORDER = ['প্রথম', 'দ্বিতীয়', 'দ্বিতীয়', 'তৃতীয়', 'তৃতীয়', 'চতুর্থ', 'পঞ্চম', 'ষষ্ঠ', 'সপ্তম', 'অষ্টম', 'নবম', 'দশম', 'একাদশ', 'দ্বাদশ'];

  const originalRenderSchoolApp = window.renderSchoolApp;
  const originalAppBook = window.appBook;
  const originalAppSet = window.appSet;
  const originalAppRouteHash = window.appRouteHash;
  const originalAppHome = window.appHome;
  let catalog = { version: 1, classes: [], books: [], solutions: {} };
  let localFiles = {};
  let canPersist = false;
  let lastWarning = '';
  let adminSession = { checked: false, loggedIn: false, id: '' };
  let solutionCancel = false;

  function esc(value) {
    return typeof escapeSearchText === 'function' ? escapeSearchText(value) : String(value == null ? '' : value);
  }
  function plain(value) {
    return typeof searchPlainText === 'function' ? searchPlainText(value) : String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function isWeakAnswer(answer) {
    const text = plain(String(answer || '')).replace(/\s+/g, ' ').trim();
    if (text.length < 4) return true;
    if (text.indexOf('নিশ্চিত উত্তর') !== -1) return true;
    if (text.indexOf('এই পৃষ্ঠা থেকে') !== -1 && text.indexOf('পাও') !== -1) return true;
    return text === 'উত্তর পাওয়া যায়নি' || text === 'উত্তর পাওয়া যায়নি';
  }
  function isRealAnswer(answer) {
    return Boolean(answer) && answer !== 'stopped' && !isWeakAnswer(answer);
  }
  function questionKey(value) {
    return plain(value).toLowerCase().replace(/[?？।,.!]/g, '').replace(/\s+/g, ' ').trim();
  }
  function hintPages(bookId, query) {
    const set = (typeof appSet === 'function' ? appSet(bookId) : []) || [];
    const phrase = plain(query).toLowerCase();
    const words = phrase.split(' ').filter((word) => word.length > 1);
    const scored = [];
    set.forEach((item) => {
      const question = plain(item.t).toLowerCase();
      const page = Number(item.p) || 0;
      if (!question || !page) return;
      let score = 0;
      if (phrase && (question.includes(phrase) || phrase.includes(question.slice(0, 18)))) score += 80;
      words.forEach((word) => { if (question.includes(word)) score += 8; });
      if (score >= 16) scored.push({ page: page, score: score });
    });
    scored.sort((a, b) => b.score - a.score);
    const pages = [];
    scored.forEach((item) => {
      if (pages.length < 4 && pages.indexOf(item.page) === -1) pages.push(item.page);
    });
    return pages;
  }
  function usefulSavedAnswer(bookId, query) {
    const set = (typeof appSet === 'function' ? appSet(bookId) : []) || [];
    const phrase = plain(query).toLowerCase();
    if (phrase.length < 3) return '';
    const words = phrase.split(' ').filter((word) => word.length > 1);
    let best = '';
    let bestScore = 0;
    set.forEach((item) => {
      if (isWeakAnswer(item.a)) return;
      const question = plain(item.t).toLowerCase();
      if (!question) return;
      let score = 0;
      if (question.includes(phrase) || phrase.includes(question)) score = 120;
      else words.forEach((word) => { if (question.includes(word)) score += 10; });
      if (words.length && score < 120 && score < Math.ceil(words.length * 0.6) * 10) score = 0;
      if (score > bestScore) { bestScore = score; best = String(item.a || ''); }
    });
    return bestScore >= 40 ? best : '';
  }
  async function fitSlice(doc, from, to, anchor) {
    let start = Math.max(1, from);
    let end = Math.max(start, to);
    const pin = Math.min(end, Math.max(start, Number(anchor) || end));
    while (end >= start) {
      const b64 = await slicePagesBase64(doc, start, end);
      if (b64) return { from: start, to: end, b64: b64 };
      if (start === end) return null;
      if (end > pin) end -= 1;
      else if (start < pin) start += 1;
      else end -= 1;
    }
    return null;
  }
  async function postAnswerSlice(book, query, pdfBase64, retried) {
    const response = await fetch('/api/answer-from-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: query, pdfBase64: pdfBase64, bookTitle: book.title, className: book.className || classLabel(appState.classId) })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 && !retried) {
      await sleep(5000);
      return postAnswerSlice(book, query, pdfBase64, true);
    }
    if (!response.ok) throw new Error(data.error || 'ফাইল থেকে উত্তর পড়া যায়নি।');
    return data;
  }
  function matchFilled(question, filled) {
    const key = questionKey(question);
    if (!key) return '';
    let hit = (filled || []).find((item) => questionKey(item.question) === key);
    if (!hit) {
      hit = (filled || []).find((item) => {
        const other = questionKey(item.question);
        if (!other || other.length < 8 || key.length < 8) return false;
        return key.includes(other.slice(0, 24)) || other.includes(key.slice(0, 24));
      });
    }
    return hit && isRealAnswer(hit.answer) ? hit.answer : '';
  }
  async function fillWeakItems(job, doc, box) {
    const weak = (job.items || []).filter((item) => isWeakAnswer(item.answer));
    if (!weak.length || !doc) return 0;
    const groups = [];
    weak.slice().sort((a, b) => (Number(a.page) || 1) - (Number(b.page) || 1)).forEach((item) => {
      const page = Number(item.page) || Number(item.sliceFrom) || 1;
      const last = groups[groups.length - 1];
      if (last && page <= last.max + 5 && last.items.length < 8) {
        last.items.push(item);
        last.max = Math.max(last.max, page);
        last.min = Math.min(last.min, page);
      } else groups.push({ min: page, max: page, items: [item] });
    });
    let fixed = 0;
    let fallbackCalls = 0;
    for (let index = 0; index < groups.length; index += 1) {
      if (solutionCancel) break;
      const group = groups[index];
      const anchor = group.min;
      const from = Math.max(1, Math.min(group.min, Number(group.items[0].sliceFrom) || group.min) - 6);
      const to = Math.min(job.pageCount || doc.getPageCount(), Math.max(group.max, Number(group.items[0].sliceTo) || group.max) + 2);
      if (box) box.innerHTML = progressHtml(job, job.title + ' — খালি উত্তর পূরণ হচ্ছে (' + bnNum(index + 1) + '/' + bnNum(groups.length) + ')…');
      const slice = await fitSlice(doc, from, to, anchor);
      if (!slice) continue;
      let filled = [];
      try {
        const data = await postJson('/api/solution-job', {
          pdfBase64: slice.b64,
          startPage: slice.from,
          endPage: slice.to,
          bookTitle: job.title,
          className: job.className,
          questions: group.items.map((item) => ({ question: item.question, page: item.page }))
        });
        filled = data.fill ? (data.items || []) : [];
      } catch (error) {
        if (/লগইন/.test(error.message || '')) throw error;
        filled = [];
      }
      group.items.forEach((item) => {
        const answer = matchFilled(item.question, filled);
        if (answer) { item.answer = answer; fixed += 1; }
      });
      for (const item of group.items) {
        if (solutionCancel || !isWeakAnswer(item.answer) || fallbackCalls >= 48) continue;
        fallbackCalls += 1;
        try {
          const data = await postAnswerSlice(bookForJob(job), item.question, slice.b64);
          if (data.found && isRealAnswer(data.answer)) { item.answer = data.answer; fixed += 1; }
        } catch (error) {
          if (/লগইন|GEMINI_API_KEY/.test(error.message || '')) throw error;
        }
      }
      writeJob(job);
    }
    return fixed;
  }
  function bookForJob(job) {
    return { id: job.bookId, title: job.title || 'বই', className: job.className || '' };
  }

  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  function classSortKey(name) {
    const index = ORDER.findIndex((item) => String(name).includes(item));
    return index === -1 ? 100 : index;
  }
  function classBadge(name, index) {
    const map = { 'প্রথম': '১', 'দ্বিতীয়': '২', 'দ্বিতীয়': '২', 'তৃতীয়': '৩', 'তৃতীয়': '৩', 'চতুর্থ': '৪', 'পঞ্চম': '৫', 'ষষ্ঠ': '৬', 'সপ্তম': '৭', 'অষ্টম': '৮', 'নবম': '৯', 'দশম': '১০', 'একাদশ': '১১', 'দ্বাদশ': '১২' };
    for (const key of Object.keys(map)) if (String(name).includes(key)) return map[key];
    return typeof bnNum === 'function' ? bnNum(index + 1) : String(index + 1);
  }
  function previewFromLink(link) {
    const value = String(link || '');
    const file = value.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
    if (file) return `https://drive.google.com/file/d/${file[1]}/preview`;
    const id = value.match(/[?&]id=([^&#]+)/);
    if (id && /google\.com|googleusercontent\.com/.test(value)) return `https://drive.google.com/file/d/${id[1]}/preview`;
    return value;
  }
  function safeUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      return url.toString();
    } catch (_) { return ''; }
  }
  function iconFor(title) {
    let n = 0;
    const text = String(title || 'বই');
    for (const ch of text) n = (n + ch.charCodeAt(0)) % ICONS.length;
    return ICONS[n];
  }
  function getCatalog() { return catalog; }
  function builtinBooks() {
    const source = typeof classThreeBooks !== 'undefined' ? classThreeBooks : [];
    return source.map((book) => ({
      id: book.id,
      classId: 'class-3',
      title: book.title,
      icon: book.icon || '📘',
      link: book.link || '',
      preview: book.preview || previewFromLink(book.link || ''),
      builtin: true,
      published: true
    }));
  }
  function allClasses() {
    const custom = (catalog.classes || []).filter((item) => item && item.id && item.id !== 'class-3');
    return [{ id: 'class-3', name: 'তৃতীয় শ্রেণী', builtin: true }].concat(custom)
      .sort((a, b) => classSortKey(a.name) - classSortKey(b.name) || String(a.name).localeCompare(String(b.name), 'bn'));
  }
  function bookHasSolutions(book) {
    const overlay = catalog.solutions && catalog.solutions[book.id];
    if (Array.isArray(overlay) && overlay.length) return true;
    return Boolean(book.builtin && book.hasSolutions !== false && BUILTIN_IDS.has(book.id) && originalAppBook(book.id)?.hasSolutions);
  }
  function booksForClass(classId, opts) {
    const publishedOnly = Boolean(opts && opts.publishedOnly);
    const builtin = classId === 'class-3' ? builtinBooks() : [];
    const custom = (catalog.books || []).filter((book) => book.classId === classId && !BUILTIN_IDS.has(book.id));
    return builtin.concat(custom).filter((book) => !publishedOnly || book.builtin || book.link || book.fileName || localFiles[book.id]);
  }
  function findBook(id) {
    return booksForClass('class-3').concat(catalog.books || []).find((book) => book.id === id) || null;
  }
  function classLabel(classId) {
    return (allClasses().find((item) => item.id === classId) || {}).name || 'শ্রেণী';
  }
  function syncAppSubjects() {
    if (typeof appSubjects === 'undefined' || !Array.isArray(appSubjects)) return;
    const published = (catalog.books || []).filter((book) => book.link);
    const ids = new Set(published.map((book) => book.id));
    for (let i = appSubjects.length - 1; i >= 0; i -= 1) {
      if (!BUILTIN_IDS.has(appSubjects[i].id) && !ids.has(appSubjects[i].id)) appSubjects.splice(i, 1);
    }
    published.forEach((book) => {
      const found = appSubjects.find((item) => item.id === book.id);
      if (found) {
        found.title = book.title;
        found.icon = book.icon || found.icon;
      } else {
        appSubjects.push({ id: book.id, title: book.title, icon: book.icon || '📘', ready: true });
      }
    });
  }

  window.appBook = function (id) {
    const custom = (catalog.books || []).find((book) => book.id === id);
    if (custom) {
      return {
        id: custom.id,
        title: custom.title,
        icon: custom.icon || '📘',
        link: custom.link || '',
        preview: custom.preview || previewFromLink(custom.link || ''),
        hasSolutions: bookHasSolutions(custom),
        solutionStatus: bookHasSolutions(custom) ? 'সংরক্ষিত সমাধান বই' : ''
      };
    }
    return originalAppBook(id);
  };
  window.answerBookInfo = function (bookId) {
    if (!bookId) return null;
    if (bookId === 'general') return { id: 'general', title: 'সাধারণ জ্ঞান', icon: '🌐', general: true };
    const book = window.appBook(bookId);
    return book && book.title ? book : null;
  };
  const originalSelectAnswerBook = window.selectAnswerBook;
  window.selectAnswerBook = function (bookId) {
    const query = String(appState.searchQuery || appState.generatedQuery || '').trim();
    if (bookId && bookId !== 'general' && query && (!BUILTIN_IDS.has(bookId) || localFiles[bookId])) return answerFromAddedBook(bookId, query);
    return originalSelectAnswerBook ? originalSelectAnswerBook(bookId) : undefined;
  };
  const originalSearchBookAnswers = window.searchBookAnswers;
  window.searchBookAnswers = function (query, bookId) {
    const rows = originalSearchBookAnswers ? originalSearchBookAnswers(query, bookId) : [];
    return rows.filter((entry) => entry && !isWeakAnswer(entry.answer));
  };
  window.appSet = function (id) {
    const overlay = catalog.solutions && catalog.solutions[id];
    if (Array.isArray(overlay) && overlay.length) return overlay;
    if (BUILTIN_IDS.has(id)) return originalAppSet(id);
    return [];
  };

  function normalizeClassId(value) {
    if (!value || value === '3' || value === 'class-3') return value ? 'class-3' : '';
    return /^c-[a-z0-9]+$/i.test(value) ? value : '';
  }
  function knownBook(id) {
    if (!id) return false;
    if (BUILTIN_IDS.has(id)) return true;
    return (catalog.books || []).some((book) => book.id === id);
  }
  window.appRouteHash = function (state) {
    const current = state || appState;
    const params = new URLSearchParams();
    const classId = current.classId || (current.classNo ? `class-${current.classNo}` : '');
    if (classId) params.set('class', classId === 'class-3' ? '3' : classId);
    if (current.bookId) params.set('book', current.bookId);
    if (current.answerBookId) params.set('answerBook', current.answerBookId);
    if (current.mode) params.set('mode', current.mode);
    if (Number.isInteger(current.solutionIndex)) params.set('item', String(current.solutionIndex));
    if (current.searchQuery) params.set('q', current.searchQuery);
    return `#/${current.screen || 'home'}?${params.toString()}`;
  };
  window.appRouteFromHash = function () {
    if (!window.location) return { screen: 'home', classNo: null, classId: null, bookId: null, mode: null, solutionIndex: null, searchQuery: '', answerBookId: '' };
    const raw = window.location.hash.replace(/^#\//, '');
    if (!raw) return { screen: 'home', classNo: null, classId: null, bookId: null, mode: null, solutionIndex: null, searchQuery: '', answerBookId: '' };
    const [screen, query = ''] = raw.split('?');
    const valid = ['home', 'classes', 'search', 'sectors', 'books', 'reader', 'solutions', 'marked', 'login', 'settings'];
    if (!valid.includes(screen)) return { screen: 'home', classNo: null, classId: null, bookId: null, mode: null, solutionIndex: null, searchQuery: '', answerBookId: '' };
    const params = new URLSearchParams(query);
    const classId = normalizeClassId(params.get('class'));
    const bookId = params.get('book');
    if (['reader', 'solutions'].includes(screen) && bookId && !knownBook(bookId)) {
      return { screen: 'classes', classNo: null, classId: classId || null, bookId: null, mode: null, solutionIndex: null, searchQuery: '', answerBookId: '' };
    }
    const item = Number(params.get('item'));
    return {
      screen,
      classNo: classId === 'class-3' ? 3 : null,
      classId: classId || null,
      bookId: bookId || null,
      answerBookId: params.get('answerBook') || '',
      mode: params.get('mode') === 'solutions' ? 'solutions' : 'reader',
      solutionIndex: Number.isInteger(item) && item >= 0 ? item : null,
      searchQuery: params.get('q') || ''
    };
  };
  window.appGo = function (screen, change) {
    if (screen !== 'settings') solutionCancel = true;
    appState = Object.assign({}, appState, change || {}, { screen: screen });
    if (!appState.classId && appState.classNo) appState.classId = `class-${appState.classNo}`;
    appWriteUrl(false);
    renderSchoolApp();
  };
  window.appHome = function () {
    solutionCancel = true;
    appState = { screen: 'home', classNo: null, classId: null, bookId: null, mode: null, solutionIndex: null, searchQuery: '', answerBookId: '' };
    appWriteUrl(false);
    renderSchoolApp();
  };

  function renderNav() {
    const nav = document.querySelector('.nav-links');
    if (!nav) return;
    const loginLabel = adminSession.loggedIn ? 'সেটিংস' : 'লগইন';
    const loginTarget = adminSession.loggedIn ? 'settings' : 'login';
    nav.innerHTML = `<button type="button" data-app-nav="home">হোম</button><button type="button" data-app-nav="search">খুঁজুন</button><button type="button" data-app-nav="marked">উমায়রার পড়া</button><button type="button" data-app-nav="classes">শ্রেণী</button><button type="button" class="nav-accent" data-app-nav="${loginTarget}">${loginLabel}</button>`;
    nav.querySelectorAll('[data-app-nav]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.appNav;
        if (target === 'home') appHome();
        else if (target === 'search') appGo('search', { bookId: null, mode: null, solutionIndex: null });
        else if (target === 'marked') appGo('marked', { bookId: null, mode: null, solutionIndex: null });
        else if (target === 'classes') appGo('classes', { bookId: null, mode: null, solutionIndex: null });
        else appGo(target, { bookId: null, mode: null, solutionIndex: null });
      });
    });
  }

  function classesMarkup() {
    const cards = allClasses().map((item, index) => {
      const count = booksForClass(item.id, { publishedOnly: true }).length;
      const classNo = item.id === 'class-3' ? 3 : 'null';
      return `<button class="app-class-card" onclick="appGo('sectors',{classId:'${item.id}',classNo:${classNo},bookId:null,mode:null,solutionIndex:null})"><span class="num">শ্রেণী ${classBadge(item.name, index)}</span><strong>${esc(item.name)}</strong><span>${count ? `${bnNum(count)}টি বই দেখুন →` : 'বই ও সমাধান দেখুন →'}</span></button>`;
    }).join('');
    return `<div class="school-app"><div class="app-shell class-selection">${appHeader('<b>শ্রেণী</b>')}<div class="app-panel"><div class="subject-heading"><h1>শ্রেণী নির্বাচন করুন</h1><p>আপনার শ্রেণীতে ক্লিক করে মূল বই ও সমাধান দেখুন।</p></div><div class="app-class-grid">${cards}</div></div></div></div>`;
  }
  function sectorsMarkup() {
    const classId = appState.classId || 'class-3';
    const name = esc(classLabel(classId));
    return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › বই নির্বাচন`)}<div class="book-option-grid"><article class="book-option"><div class="option-icon">📚</div><h2>মূল বই</h2><p>বিষয় নির্বাচন করে সম্পূর্ণ মূল বই ফুল পেজে পড়ুন।</p><button onclick="appGo('books',{classId:'${classId}',mode:'reader',bookId:null,solutionIndex:null})">মূল বই দেখুন →</button></article><article class="book-option solution-option"><div class="option-icon">💡</div><h2>সমাধান</h2><p>আগে চেষ্টা করুন, না পারলে প্রশ্নভিত্তিক সমাধান দেখুন।</p><button onclick="appGo('books',{classId:'${classId}',mode:'solutions',bookId:null,solutionIndex:null})">সমাধান দেখুন →</button></article></div></div></div>`;
  }
  function booksMarkup() {
    const classId = appState.classId || 'class-3';
    const name = esc(classLabel(classId));
    const isSolution = appState.mode === 'solutions';
    const items = booksForClass(classId, { publishedOnly: true }).filter((book) => !isSolution || bookHasSolutions(book));
    const cards = items.map((book) => `<button class="app-subject-card ready" onclick="appGo('${isSolution ? 'solutions' : 'reader'}',{classId:'${classId}',bookId:'${book.id}',mode:'${isSolution ? 'solutions' : 'reader'}',solutionIndex:0})"><span class="sub-icon">${book.icon || '📘'}</span><b>${esc(book.title)}</b><small>${isSolution ? 'সমাধান খুলুন' : 'মূল বই খুলুন'}</small></button>`).join('');
    const empty = `<div class="marked-empty"><div>📚</div><h2>${isSolution ? 'এই শ্রেণীর সমাধান এখনো তৈরি হয়নি' : 'এই শ্রেণীর বই এখনো যোগ করা হয়নি'}</h2><p>${isSolution ? 'এডমিন সেটিংস থেকে সমাধান তৈরি করলে এখানে দেখা যাবে।' : 'এডমিন বইয়ের লিংক সেভ করলে এখানে দেখা যাবে।'}</p></div>`;
    return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${isSolution ? 'সমাধানের বই' : 'মূল বইয়ের তালিকা'}`)}<div class="app-panel"><div class="subject-heading"><h1>${isSolution ? 'সমাধানের বই নির্বাচন করুন' : 'বই নির্বাচন করুন'}</h1><p>${isSolution ? 'যে বইয়ের সমাধান দেখতে চান সেটিতে ক্লিক করুন।' : 'যে মূল বইটি পড়তে চান সেটিতে ক্লিক করুন।'}</p></div><div class="app-subject-grid">${cards || empty}</div></div></div></div>`;
  }

  function isEnglishBook(bookId) {
    if (!bookId) return false;
    if (bookId === 'english') return true;
    const book = typeof window.appBook === 'function' ? window.appBook(bookId) : null;
    return /english|ইংরেজি/i.test(String((book && book.title) || ''));
  }
  function bookVoiceLang(bookId) {
    return isEnglishBook(bookId) ? 'en-US' : 'bn-BD';
  }
  function directBookUrl(link) {
    const value = String(link || '');
    const share = value.match(/^(https?:\/\/[^/]+)\/index\.php\/s\/([^/?#]+)/i);
    if (share) return share[1] + '/index.php/s/' + share[2] + '/download';
    return value;
  }
  function viewableBookUrl(link) {
    const value = String(link || '');
    if (!value) return '';
    const driveFile = value.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
    if (driveFile) return 'https://drive.google.com/file/d/' + driveFile[1] + '/preview';
    const driveId = value.match(/[?&]id=([^&#]+)/);
    if (driveId && /google\.com|googleusercontent\.com/.test(value)) return 'https://drive.google.com/file/d/' + driveId[1] + '/preview';
    if (/drive\.google\.com\/file\/d\/.+\/preview/.test(value)) return value;
    const download = directBookUrl(value);
    if (download !== value || /\.pdf($|\?)/i.test(value)) {
      return 'https://docs.google.com/viewer?embedded=true&url=' + encodeURIComponent(download);
    }
    return value;
  }
  let viewerState = null;
  async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('PDF ভিউয়ার লোড হয়নি।'));
      document.head.appendChild(script);
    });
    if (!window.pdfjsLib) throw new Error('PDF ভিউয়ার লোড হয়নি।');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return window.pdfjsLib;
  }
  async function renderViewerPage(page) {
    const host = document.getElementById('localBookViewer');
    if (!viewerState || !host || appState.bookId !== viewerState.bookId) return;
    const total = viewerState.doc.numPages;
    const next = Math.max(1, Math.min(total, page || 1));
    viewerState.page = next;
    host.innerHTML = '<div class="book-viewer"><div class="book-viewer-bar"><button type="button" onclick="stepBookPage(-1)">← আগের পাতা</button><span>পৃষ্ঠা ' + bnNum(next) + ' / ' + bnNum(total) + '</span><button type="button" onclick="stepBookPage(1)">পরের পাতা →</button></div><div class="book-viewer-canvas"><canvas id="bookPageCanvas"></canvas></div></div>';
    const pdfPage = await viewerState.doc.getPage(next);
    const canvas = document.getElementById('bookPageCanvas');
    if (!canvas) return;
    const base = pdfPage.getViewport({ scale: 1 });
    const width = Math.max(320, (host.clientWidth || 800) - 24);
    const viewport = pdfPage.getViewport({ scale: width / base.width });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
  }
  window.stepBookPage = function (delta) {
    if (!viewerState) return;
    renderViewerPage(viewerState.page + delta);
  };
  async function renderPdfBytes(host, bytes, bookId) {
    const lib = await loadPdfJs();
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = await lib.getDocument({ data: data }).promise;
    viewerState = { doc: doc, page: 1, bookId: bookId };
    await renderViewerPage(1);
  }
  function renderImagePages(host, images) {
    const html = images.map((file, index) => {
      const url = URL.createObjectURL(new Blob([file.bytes], { type: file.type || 'image/jpeg' }));
      return '<img src="' + url + '" alt="পৃষ্ঠা ' + (index + 1) + '">';
    }).join('');
    host.innerHTML = '<div class="book-viewer"><div class="book-viewer-bar"><span>আপলোড করা ছবি</span></div><div class="book-viewer-canvas">' + html + '</div></div>';
  }
  async function mountBookViewer(bookId) {
    const host = document.getElementById('localBookViewer');
    if (!host) return;
    host.innerHTML = '<p style="padding:16px">বই খোলা হচ্ছে…</p>';
    try {
      const row = await getBookFiles(bookId);
      const files = row && row.files ? row.files : [];
      const pdf = files.find((file) => fileKind(file) === 'pdf');
      if (pdf) {
        await renderPdfBytes(host, pdf.bytes, bookId);
        return;
      }
      const images = files.filter((file) => fileKind(file) === 'image');
      if (images.length) {
        renderImagePages(host, images);
        return;
      }
    } catch (error) {
      try {
        const row = await getBookFiles(bookId);
        const pdf = row && row.files && row.files.find((file) => fileKind(file) === 'pdf');
        if (pdf) {
          const url = URL.createObjectURL(new Blob([pdf.bytes], { type: 'application/pdf' }));
          host.innerHTML = '<iframe src="' + url + '" title="বই" style="width:100%;height:100%;border:0;background:#fff"></iframe>';
          return;
        }
      } catch (_) {}
      host.innerHTML = '<p style="padding:16px">' + esc(error.message || 'বই খোলা যায়নি।') + '</p>';
    }
    if (!document.getElementById('localBookViewer')) return;
    const book = appBook(bookId);
    const remote = viewableBookUrl(book && (book.link || book.preview));
    const open = directBookUrl(book && book.link);
    if (!remote) {
      host.innerHTML = '<p style="padding:16px">এই বইয়ের লিংক বা PDF সেভ করা নেই। সেটিংস থেকে URL বা PDF দিন।</p>';
      return;
    }
    host.innerHTML = '<div class="book-viewer"><div class="book-viewer-bar"><a href="' + esc(open || remote) + '" target="_blank" rel="noopener">↗ নতুন ট্যাবে পুরো বই</a></div><iframe src="' + esc(remote) + '" title="' + esc((book && book.title) || 'বই') + '" style="width:100%;height:100%;border:0;background:#fff"></iframe></div>';
  }
  function solutionContextForQuestion(bookId, query) {
    const set = appSet(bookId) || [];
    const phrase = plain(query).toLowerCase();
    const words = phrase.split(' ').filter((word) => word.length > 1);
    const ranked = set.map((item) => {
      if (isWeakAnswer(item.a)) return null;
      const question = plain(item.t).toLowerCase();
      const answer = plain(item.a).toLowerCase();
      let score = 0;
      if (phrase && (question.includes(phrase) || phrase.includes(question))) score += 80;
      words.forEach((word) => {
        if (question.includes(word)) score += 12;
        if (answer.includes(word)) score += 6;
      });
      return { item: item, score: score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (!ranked.some((row) => row.score >= 12)) return '';
    return ranked.filter((row) => row.score > 0).slice(0, 8).map((row) => {
      const item = row.item;
      return 'অধ্যায়: ' + plain(item.l) + '\nপ্রশ্ন: ' + plain(item.t) + '\nউত্তর: ' + plain(item.a);
    }).join('\n\n').slice(0, 14000);
  }
  function looksUnanswered(answer) {
    const text = plain(answer);
    return !isRealAnswer(text) || /এই বইয়ে নেই|বইয়ে পাওয়া যায়নি|উত্তর নেই|not found|cannot find/i.test(text);
  }
  async function answerFromSavedBook(book, query) {
    const context = solutionContextForQuestion(book.id, query);
    if (!context) return '';
    const response = await fetch('/api/generate-answer-v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: query,
        bookTitle: book.title,
        context: context,
        externalFallback: false,
        answerLanguage: isEnglishBook(book.id) ? 'en' : 'bn'
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return '';
    const answer = String(data.answer || '');
    return looksUnanswered(answer) ? '' : answer;
  }

  function customBookScreen() {
    const book = appBook(appState.bookId);
    if (!book) return classesMarkup();
    const name = esc(classLabel(appState.classId || book.classId || 'class-3'));
    const set = appSet(appState.bookId) || [];
    if (appState.screen === 'reader') {
      const preview = book.preview || book.link;
      return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${esc(book.title)} › মূল বই`)}<div class="reader-page"><div class="reader-frame" id="localBookViewer"><p style="padding:16px">বই খোলা হচ্ছে…</p></div><aside class="reader-side"><div class="side-title"><h2>অনুশীলনী সূচি</h2><p>প্রশ্নে ক্লিক করে সমাধানে যান</p></div><div class="side-scroll">${set.length ? set.map((item, index) => `<button class="reader-question" onclick="appGo('solutions',{bookId:'${book.id}',mode:'solutions',solutionIndex:${index}})"><small>পৃষ্ঠা ${bnNum(item.p)} · প্রশ্ন ${esc(item.q)}</small>${item.l}</button>`).join('') : '<p style="padding:10px;color:#648075">এই বইয়ের সমাধান এখনো তৈরি হয়নি।</p>'}</div>${book.link ? `<a class="reader-fallback" href="${esc(directBookUrl(book.link))}" target="_blank" rel="noopener">↗ নতুন ট্যাবে বড় করে পড়ুন</a>` : ''}</aside></div></div></div>`;
    }
    const index = Number.isInteger(appState.solutionIndex) && set[appState.solutionIndex] ? appState.solutionIndex : 0;
    if (!set.length) {
      return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${esc(book.title)} › সমাধান`)}<div class="app-panel"><div class="marked-empty"><div>💡</div><h2>সমাধান এখনো সংরক্ষণ হয়নি</h2><p>এডমিন সেটিংসের “সমাধান তৈরী করুন” থেকে এই বইয়ের সমাধান বই তৈরি হবে।</p></div></div></div></div>`;
    }
    return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${esc(book.title)} › সমাধান`)}<div class="solution-page"><aside class="solution-side"><div class="side-title"><h2>সমাধান সূচি</h2><p>যে প্রশ্নটি দেখতে চান ক্লিক করুন</p></div><div class="side-scroll">${set.map((item, itemIndex) => `<button class="solution-jump ${itemIndex === index ? 'active' : ''}" onclick="appGo('solutions',{bookId:'${book.id}',mode:'solutions',solutionIndex:${itemIndex}})">পৃষ্ঠা ${bnNum(item.p)} · প্রশ্ন ${esc(item.q)}<br><span style="font-weight:700;font-size:11px">${item.l}</span></button>`).join('')}</div></aside><main class="solution-main"><button class="solution-return" onclick="appBack()">← ব্যাক</button><div class="solution-header"><h1>${esc(book.title)} — সমাধান</h1><p>আগে চেষ্টা করো, না পারলে ধাপে ধাপে সমাধান দেখো।</p></div><div class="solution-tip">💡 এটি সংরক্ষিত সমাধান বই। প্রয়োজনীয় প্রশ্ন চিহ্নিত করতে নিচের টিক ব্যবহার করুন।</div>${set.map((item, itemIndex) => `<article id="full-solution-${itemIndex}" class="standard-card ${itemIndex === index ? 'active' : ''}"><div class="standard-card-head"><span class="pno">পৃষ্ঠা ${bnNum(item.p)}</span><div><strong>${item.l} · প্রশ্ন ${esc(item.q)}</strong><small>${esc(item.type || appQuestionType(item))}</small></div></div><div class="standard-question"><b>মূল বইয়ের প্রশ্ন · প্রশ্ন ${esc(item.q)}</b><div class="standard-question-text">${item.t}</div></div><div class="standard-answer-label">সমাধান</div><div class="standard-answer">${isWeakAnswer(item.a) ? '<p>এই প্রশ্নের উত্তর এখনো বই থেকে পূরণ হয়নি। সেটিংসে “খালি উত্তর পূরণ করুন” চাপুন।</p>' : solutionAnswerMarkup(item, book.id, itemIndex, true)}</div></article>`).join('')}</main></div></div></div>`;
  }

  function loginMarkup() {
    if (adminSession.loggedIn) {
      return `<div class="school-app"><form class="login-card" onsubmit="return false"><span class="app-kicker">এডমিন</span><h1>আপনি লগইন আছেন</h1><p>আইডি: ${esc(adminSession.id || 'Uzzal')}</p><div class="admin-form"><button type="button" onclick="appGo('settings',{bookId:null})">সেটিংস খুলুন</button><button type="button" class="secondary" onclick="adminLogout()">লগআউট</button></div></form></div>`;
    }
    return `<div class="school-app"><form class="login-card" onsubmit="submitAdminLogin(event)"><span class="app-kicker">এডমিন লগইন</span><h1>লগইন করুন</h1><p>শ্রেণী, বই ও সমাধান যোগ করতে এডমিন আইডি ও পাসওয়ার্ড দিন।</p><label>আইডি<input id="adminIdInput" name="username" autocomplete="username" required></label><label>পাসওয়ার্ড<input id="adminPasswordInput" name="password" type="password" autocomplete="current-password" required></label><div id="loginStatus" class="login-status"></div><button class="generate-answer-button" type="submit" style="width:100%;height:46px">লগইন</button></form></div>`;
  }
  function optionList(items, selected, placeholder) {
    const head = `<option value="">${placeholder}</option>`;
    return head + items.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.name || item.title)}</option>`).join('');
  }
  function settingsMarkup() {
    if (!adminSession.checked) return `<div class="school-app"><div class="app-shell"><p class="admin-note">সেটিংস লোড হচ্ছে…</p></div></div>`;
    if (!adminSession.loggedIn) return `<div class="school-app"><div class="app-shell"><div class="admin-card"><h2>লগইন প্রয়োজন</h2><p>সেটিংস দেখতে আগে লগইন করুন।</p><button class="admin-inline-button" onclick="appGo('login',{bookId:null})">লগইন পেজ</button></div></div></div>`;
    const classes = allClasses();
    const selectedClass = appState.settingsClassId || classes[0]?.id || '';
    const classBooks = selectedClass ? booksForClass(selectedClass) : [];
    const urlBooks = classBooks.filter((book) => !book.builtin);
    const selectedBook = urlBooks.some((book) => book.id === appState.settingsBookId) ? appState.settingsBookId : (urlBooks[0]?.id || '');
    const solutionClass = appState.solutionClassId || selectedClass;
    const solutionBooks = booksForClass(solutionClass, { publishedOnly: true });
    const solutionBook = solutionBooks.some((book) => book.id === appState.solutionBookId) ? appState.solutionBookId : (solutionBooks[0]?.id || '');
    const warning = lastWarning ? `<p class="admin-note warn">${esc(lastWarning)}</p>` : (canPersist ? '<p class="admin-note">সেভ করলে শ্রেণী ও বই সবার লাইভ সাইটে দেখা যাবে।</p>' : '<p class="admin-note warn">লাইভ সাইটে সবার জন্য সেভ করতে Vercel Environment Variable-এ GITHUB_TOKEN যোগ করুন। টোকেনে এই রিপোতে লেখার অনুমতি থাকতে হবে।</p>');
    const classItems = classes.map((item) => `<div class="admin-list-item"><div><b>${esc(item.name)}</b><small>${item.builtin ? 'আগ থেকে থাকা শ্রেণী' : 'নতুন শ্রেণী'} · ${bnNum(booksForClass(item.id, { publishedOnly: true }).length)}টি বই</small></div>${item.builtin ? '' : `<button type="button" onclick="removeAdminClass('${item.id}')">মুছুন</button>`}</div>`).join('');
    const bookItems = classBooks.map((book) => `<div class="admin-list-item"><div><b>${book.icon || '📘'} ${esc(book.title)}</b><small>${book.link ? 'লিংক সেভ হয়েছে' : 'এখনো URL দেওয়া হয়নি'}${localFiles[book.id] ? ' · ফাইল: ' + esc(localFiles[book.id]) : ''} ${bookHasSolutions(book) ? '· সমাধান আছে' : ''}</small></div>${book.builtin ? '' : `<button type="button" onclick="removeAdminBook('${book.id}')">মুছুন</button>`}</div>`).join('');
    const job = readJob();
    const resume = job ? `<p class="admin-note">অসমাপ্ত সমাধান আছে: ${esc(job.title || 'বই')} · পৃষ্ঠা ${bnNum(job.nextPage)}/${bnNum(job.pageCount)}। <button type="button" class="admin-inline-button" onclick="resumeSolutionJob()">চালিয়ে যান</button></p>` : '';
    return `<div class="school-app"><div class="admin-wrap admin-stack">${appHeader('<b>সেটিংস</b>')}<div class="admin-card"><div class="subject-heading"><h1>এডমিন সেটিংস</h1><p>লগইন: ${esc(adminSession.id || 'Uzzal')}</p></div><div class="admin-form"><button type="button" class="secondary" onclick="adminLogout()">লগআউট</button></div>${warning}</div>
      <section class="admin-card"><h2>নতুন শ্রেণী যোগ করুন</h2><p>শ্রেণীর নাম লিখে যোগ করুন। যোগ করা শ্রেণী শ্রেণী পেজে দেখা যাবে।</p><form class="admin-form" onsubmit="addAdminClass(event)"><input id="newClassName" placeholder="যেমন: চতুর্থ শ্রেণী" aria-label="নতুন শ্রেণীর নাম"><button type="submit">শ্রেণী যোগ করুন</button></form><div class="admin-list">${classItems}</div></section>
      <section class="admin-card"><h2>বই যোগ করুন</h2><p>শ্রেণী বেছে নিয়ে বইয়ের নাম যোগ করুন। তারপর নিচের ড্রপডাউন থেকে বই বেছে URL সেভ করুন।</p><form class="admin-form" onsubmit="addAdminBook(event)"><select id="bookClassSelect" onchange="setSettingsClass(this.value)">${optionList(classes, selectedClass, 'শ্রেণী নির্বাচন')}</select><input id="newBookName" placeholder="বইয়ের নাম" aria-label="বইয়ের নাম"><button type="submit">বইয়ের নাম যোগ করুন</button></form>
      ${urlBooks.length ? `<form class="admin-form" onsubmit="saveAdminBookUrl(event)"><select id="urlBookSelect">${optionList(urlBooks, selectedBook, 'বই নির্বাচন')}</select><input id="bookUrlInput" placeholder="বইয়ের ওয়েবসাইট, Google Drive বা PDF লিংক" aria-label="বইয়ের URL"><button class="warn" type="submit">URL সেভ করুন</button></form>` : '<p class="admin-note">এই শ্রেণীতে বইয়ের নাম যোগ করলে এখানে বইয়ের ড্রপডাউন আসবে।</p>'}
      <form class="admin-form" onsubmit="saveAdminBookFile(event)"><select id="fileBookSelect">${optionList(classBooks, selectedBook, 'বই নির্বাচন')}</select><input id="bookFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,application/pdf,image/*,text/plain" multiple aria-label="বইয়ের ফাইল" style="height:auto;padding:8px"><button type="submit">ফাইল সেভ করুন</button></form>
      <p class="admin-note">লিংকের পাশাপাশি PDF, JPG বা TXT আপলোড করুন। AI তখন সরাসরি ফাইল পড়ে উত্তর দেবে। বড় PDF এই ব্রাউজারে সেভ থাকে।${localFiles[selectedBook] ? ' সেভ করা ফাইল: ' + esc(localFiles[selectedBook]) : ''}</p>
      <div class="admin-list">${bookItems || '<p class="admin-note">এই শ্রেণীতে এখনো নতুন বই নেই।</p>'}</div></section>
      <section class="admin-card"><h2>সমাধান তৈরী করুন</h2><p>শ্রেণী ও বই বেছে নিয়ে বাটনে চাপুন। আপলোড করা PDF, JPG বা TXT থেকে পুরো বইয়ের অনুশীলনী অধ্যায়ভিত্তিক তুলে উত্তরসহ সমাধান সংরক্ষণ হবে। বড় বইয়ে ১০–২০ মিনিট লাগতে পারে। আগে বানানো সমাধানে খালি উত্তর থাকলে পুরো বই আবার না বানিয়ে “খালি উত্তর পূরণ করুন” চাপুন।</p><div class="admin-form"><select id="solutionClassSelect" onchange="setSolutionClass(this.value)">${optionList(classes, solutionClass, 'শ্রেণী নির্বাচন')}</select><select id="solutionBookSelect">${optionList(solutionBooks, solutionBook, 'বই নির্বাচন')}</select><button type="button" onclick="startSolutionJob(false)">সমাধান তৈরী করুন</button><button type="button" class="secondary" onclick="repairSavedAnswers()">খালি উত্তর পূরণ করুন</button></div>${resume}<div id="solutionProgress"></div></section></div></div>`;
  }

  window.renderSchoolApp = function () {
    syncAppSubjects();
    const root = document.getElementById('schoolApp');
    if (!root) return;
    const screen = appState.screen;
    if (screen === 'login') { root.innerHTML = loginMarkup(); return; }
    if (screen === 'settings') { root.innerHTML = settingsMarkup(); return; }
    if (screen === 'search') { root.innerHTML = window.searchPageMarkup(); return; }
    if (screen === 'classes') { root.innerHTML = classesMarkup(); return; }
    if (screen === 'sectors') { root.innerHTML = sectorsMarkup(); return; }
    if (screen === 'books') { root.innerHTML = booksMarkup(); return; }
    if ((screen === 'reader' || screen === 'solutions') && appState.classId && appState.classId !== 'class-3') {
      root.innerHTML = customBookScreen();
      if (screen === 'reader') setTimeout(() => mountBookViewer(appState.bookId), 20);
      if (screen === 'solutions') setTimeout(() => { const el = document.getElementById(`full-solution-${appState.solutionIndex || 0}`); if (el) el.scrollIntoView({ block: 'nearest' }); }, 30);
      return;
    }
    if ((screen === 'reader' || screen === 'solutions') && appState.bookId && !BUILTIN_IDS.has(appState.bookId)) {
      root.innerHTML = customBookScreen();
      if (screen === 'reader') setTimeout(() => mountBookViewer(appState.bookId), 20);
      return;
    }
    originalRenderSchoolApp();
  };

  function classPickMarkup() {
    const classes = allClasses();
    if (!appState.classId) {
      const cards = classes.map((item, index) => `<button type="button" class="search-pick-card" onclick="pickSearchClass('${item.id}')"><span class="num">শ্রেণী ${classBadge(item.name, index)}</span><b>${esc(item.name)}</b><small>এই শ্রেণীর বই দেখুন</small></button>`).join('');
      return `<p class="search-step-label">১. শ্রেণী নির্বাচন করুন</p><div class="search-pick-grid">${cards}</div>`;
    }
    const selected = classes.find((item) => item.id === appState.classId);
    return `<div class="search-chosen"><button type="button" onclick="pickSearchClass('')">শ্রেণী: ${esc(selected ? selected.name : '')} · বদলান</button></div>`;
  }
  function bookPickMarkup() {
    if (!appState.classId) return '';
    const books = booksForClass(appState.classId, { publishedOnly: true });
    if (!appState.answerBookId) {
      if (!books.length) return '<div class="search-start"><div>📚</div><h2>এই শ্রেণীতে এখনো বই নেই</h2><p>সেটিংস থেকে বইয়ের নাম ও লিংক সেভ করুন।</p></div>';
      const cards = books.map((book) => `<button type="button" class="search-pick-card" onclick="pickSearchBook('${book.id}')"><span class="sub-icon">${book.icon || '📘'}</span><b>${esc(book.title)}</b><small>এই বই থেকে উত্তর</small></button>`).join('');
      return `<p class="search-step-label">২. বই নির্বাচন করুন</p><div class="search-pick-grid">${cards}</div>`;
    }
    const selected = books.find((book) => book.id === appState.answerBookId) || appBook(appState.answerBookId);
    return `<div class="search-chosen"><button type="button" onclick="pickSearchBook('')">বই: ${esc(selected ? selected.title : '')} · বদলান</button></div>`;
  }
  window.pickSearchClass = function (classId) {
    appState = Object.assign({}, appState, { classId: classId || null, classNo: classId === 'class-3' ? 3 : null, answerBookId: '' });
    appWriteUrl(true);
    renderSchoolApp();
  };
  window.pickSearchBook = function (bookId) {
    appState = Object.assign({}, appState, { answerBookId: bookId || '' });
    appWriteUrl(true);
    renderSchoolApp();
  };
  window.searchPageMarkup = function () {
    const query = appState.searchQuery || '';
    const english = isEnglishBook(appState.answerBookId);
    const ready = Boolean(String(query).trim() && appState.classId && appState.answerBookId);
    const question = appState.classId && appState.answerBookId
      ? `<p class="search-step-label">৩. প্রশ্ন লিখুন বা ${english ? 'ইংরেজি' : 'বাংলা'} ভয়েসে বলুন</p><div class="book-search-bar"><label class="search-field"><span>🔎</span><input id="bookSearchInput" value="${esc(query)}" oninput="activateGenerateAnswerButtonFromInput(this);setBookSearchQuery(this.value)" onkeyup="activateGenerateAnswerButtonFromInput(this)" placeholder="${english ? 'Type your question…' : 'প্রশ্ন লিখুন…'}" autocomplete="off" aria-label="প্রশ্ন"></label><div class="book-search-actions"><button class="voice-search-button" type="button" onclick="startVoiceBookSearch()" aria-label="ভয়েস">${english ? '🎙️ English' : '🎙️ বাংলা ভয়েস'}</button><button id="generateAnswerButton" class="generate-answer-button" type="button" onclick="createBookAnswer()" ${ready ? '' : 'disabled'}>উত্তর তৈরী করুন</button></div></div><p id="voiceSearchStatus" class="voice-search-status">${english ? 'The question and answer will be spoken in English.' : 'প্রশ্ন ও উত্তর বাংলা ভয়েসে হবে।'}</p>`
      : '';
    return `<div class="school-app"><div class="app-shell search-page">${appHeader('<b>খুঁজুন</b>')}<div class="app-panel"><div class="subject-heading"><h1>প্রশ্ন খুঁজুন</h1><p>প্রথমে শ্রেণী, তারপর সেই শ্রেণীর বই বেছে নিন। তারপর প্রশ্ন লিখুন বা ভয়েস দিন এবং উত্তর তৈরী করুন চাপুন।</p></div>${classPickMarkup()}${bookPickMarkup()}${question}<div id="answerBookPicker"></div><div id="generatedAnswerContainer">${generatedBookAnswerMarkup(query)}</div><div id="searchDynamicContent">${searchResultContentMarkup(query)}</div></div></div></div>`;
  };
  window.searchResultContentMarkup = function (query) {
    if (!appState.classId || !appState.answerBookId || !query) return '';
    const results = searchBookAnswers(query, appState.answerBookId);
    return results.length ? `<div class="search-result-count">${bnNum(results.length)}টি প্রাসঙ্গিক প্রশ্ন ও উত্তর পাওয়া গেছে</div><div class="search-result-list">${results.map(searchResultMarkup).join('')}</div>` : '';
  };
  window.updateGenerateAnswerButton = function (query) {
    const button = document.getElementById('generateAnswerButton');
    if (!button) return;
    const enabled = Boolean(String(query || '').trim() && appState.classId && appState.answerBookId);
    button.disabled = !enabled;
    button.toggleAttribute('disabled', !enabled);
    button.setAttribute('aria-disabled', String(!enabled));
  };
  window.setSearchClass = function (classId) { window.pickSearchClass(classId); };
  window.setSearchBook = function (bookId) { window.pickSearchBook(bookId); };
  window.speechLanguageFor = function (bookId) {
    return bookVoiceLang(bookId || appState.answerBookId || appState.generatedBookId || appState.bookId);
  };
  window.startVoiceBookSearch = function () {
    if (!appState.answerBookId) return setVoiceSearchStatus('আগে বই নির্বাচন করুন।');
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return setVoiceSearchStatus('এই ব্রাউজারে ভয়েস সুবিধা নেই। প্রশ্নটি লিখে দিন।');
    const english = isEnglishBook(appState.answerBookId);
    const recognition = new Recognition();
    recognition.lang = english ? 'en-US' : 'bn-BD';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setVoiceSearchStatus(english ? 'Listening… say your question in English.' : 'শুনছি… বাংলায় প্রশ্নটি বলুন।');
    recognition.onresult = (event) => {
      const spoken = event.results[0][0].transcript;
      const input = document.getElementById('bookSearchInput');
      if (input) input.value = spoken;
      setBookSearchQuery(spoken);
      updateGenerateAnswerButton(spoken);
    };
    recognition.onerror = (event) => setVoiceSearchStatus(event.error === 'not-allowed' ? 'মাইক্রোফোন ব্যবহারের অনুমতি দিন।' : 'ভয়েস শোনা যায়নি। আবার চেষ্টা করুন বা প্রশ্নটি লিখুন।');
    try { recognition.start(); } catch (_) { setVoiceSearchStatus('একটু পরে আবার ভয়েস চালু করুন।'); }
  };

  window.createBookAnswer = async function () {
    const query = String(appState.searchQuery || '').trim();
    if (!appState.classId) return setVoiceSearchStatus('প্রথমে শ্রেণী নির্বাচন করুন।');
    if (!appState.answerBookId) return setVoiceSearchStatus('প্রথমে সেই শ্রেণীর বই নির্বাচন করুন।');
    if (!query) return setVoiceSearchStatus('প্রশ্ন লিখুন বা ভয়েস দিয়ে বলুন।');
    closeAnswerBookPicker();
    let hasFile = Boolean(localFiles[appState.answerBookId]);
    if (!hasFile) {
      try {
        const row = await getBookFiles(appState.answerBookId);
        hasFile = Boolean(row && row.files && row.files.length);
      } catch (_) {}
    }
    if (hasFile || !BUILTIN_IDS.has(appState.answerBookId)) return answerFromAddedBook(appState.answerBookId, query);
    return selectAnswerBook(appState.answerBookId);
  };

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'অনুরোধ সম্পন্ন হয়নি।');
    return data;
  }
  function beginAnswer(book, query) {
    const requestId = `${Date.now()}${Math.random()}`;
    const clean = String(query || '').trim();
    appState = Object.assign({}, appState, {
      searchQuery: clean,
      generatedBookId: book.id,
      generatedQuery: clean,
      generatedMessage: '',
      sourceViewerBookId: '',
      sourceViewerPage: 0,
      exactSourceText: '',
      exactSourceTitle: '',
      referenceAnswer: '',
      referenceTitle: '',
      aiAnswer: '',
      aiAnswerKind: '',
      aiError: '',
      aiLoading: true,
      aiFallback: false,
      aiRequestId: requestId,
      aiRegenerating: false,
      aiPreviousAnswer: '',
      aiVerificationStatus: ''
    });
    appWriteUrl(true);
    renderGeneratedBookAnswer();
    return requestId;
  }

  function finishAnswer(requestId, answer, error) {
    if (appState.aiRequestId !== requestId) return;
    const clean = isRealAnswer(answer) ? String(answer) : '';
    appState = Object.assign({}, appState, error || !clean
      ? { aiLoading: false, aiError: error || 'নির্বাচিত বই থেকে উত্তর তৈরি করা যায়নি।', aiAnswer: '', aiFallback: false, aiAnswerKind: '' }
      : { aiLoading: false, aiAnswer: clean, aiAnswerKind: 'ai', aiError: '', aiFallback: false, aiVerificationStatus: 'source-checked' });
    renderGeneratedBookAnswer();
  }


  function fileDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('AmarBoiFiles', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'bookId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('ফাইল সেভ করা যায়নি।'));
    });
  }
  function fileKind(file) {
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (type.startsWith('image/') || /\.(jpe?g|png|webp)$/.test(name)) return 'image';
    if (type.startsWith('text/') || name.endsWith('.txt')) return 'txt';
    return '';
  }
  async function putBookFiles(bookId, files) {
    const db = await fileDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ bookId: bookId, files: files, savedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('ফাইল সেভ করা যায়নি।'));
    });
    db.close();
  }
  async function getBookFiles(bookId) {
    const db = await fileDb();
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const request = tx.objectStore('files').get(bookId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return row;
  }
  async function refreshLocalFiles() {
    try {
      const db = await fileDb();
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const request = tx.objectStore('files').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      db.close();
      localFiles = {};
      rows.forEach((row) => {
        const names = (row.files || []).map((file) => file.name).filter(Boolean);
        if (names.length) localFiles[row.bookId] = names.join(', ');
      });
      (catalog.books || []).forEach((book) => {
        if (localFiles[book.id]) book.fileName = localFiles[book.id];
      });
    } catch (_) {}
    return localFiles;
  }
  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return uint8ToBase64(view);
  }
  async function imageBase64(file) {
    const blob = new Blob([file.bytes], { type: file.type || 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.72);
    return data.split(',')[1] || '';
  }
  async function answerFromPdfFile(book, query, requestId, bytes) {
    await loadPdfLib();
    let doc;
    try {
      doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch (_) {
      throw new Error('এই ব্রাউজারে বড় PDF খোলা যায়নি। কম্পিউটারের Chrome দিয়ে আবার চেষ্টা করুন।');
    }
    const pageCount = Math.min(doc.getPageCount(), 180);
    const ranges = [];
    hintPages(book.id, query).forEach((page) => {
      ranges.push([Math.max(1, page - 6), Math.min(pageCount, page + 4), page]);
    });
    for (let start = 1; start <= pageCount; start += 8) ranges.push([start, Math.min(pageCount, start + 7), Math.min(pageCount, start + 7)]);
    for (let start = 5; start <= pageCount; start += 8) ranges.push([start, Math.min(pageCount, start + 7), Math.min(pageCount, start + 7)]);
    const seen = new Set();
    let lastError = '';
    for (const range of ranges) {
      if (appState.aiRequestId !== requestId) return 'stopped';
      const key = range[0] + '-' + range[1];
      if (seen.has(key)) continue;
      seen.add(key);
      setVoiceSearchStatus('আপলোড করা PDF-এর পৃষ্ঠা ' + bnNum(range[0]) + '–' + bnNum(range[1]) + ' পড়া হচ্ছে…');
      const slice = await fitSlice(doc, range[0], range[1], range[2]);
      if (!slice) continue;
      try {
        const data = await postAnswerSlice(book, query, slice.b64);
        if (data.found && isRealAnswer(data.answer)) return data.answer;
      } catch (error) {
        lastError = error.message || lastError;
        if (/GEMINI_API_KEY|সেট করা নেই/.test(lastError)) throw error;
      }
    }
    if (lastError && /ব্যস্ত|অনেক অনুরোধ/.test(lastError)) throw new Error(lastError);
    return '';
  }

  async function answerFromLocalFile(book, query, requestId) {
    const row = await getBookFiles(book.id);
    const files = row && Array.isArray(row.files) ? row.files : [];
    if (!files.length) return '';
    const pdf = files.find((file) => fileKind(file) === 'pdf');
    if (pdf) {
      setVoiceSearchStatus('আপলোড করা PDF খোলা হচ্ছে…');
      return answerFromPdfFile(book, query, requestId, pdf.bytes);
    }
    const images = files.filter((file) => fileKind(file) === 'image').slice(0, 16);
    for (let index = 0; index < images.length; index += 1) {
      if (appState.aiRequestId !== requestId) return 'stopped';
      setVoiceSearchStatus(`ছবি ${bnNum(index + 1)} পড়া হচ্ছে…`);
      const image = await imageBase64(images[index]);
      if (!image) continue;
      const data = await postJson('/api/read-book', {
        action: 'answer-image',
        imageBase64: image,
        mimeType: 'image/jpeg',
        question: query,
        bookTitle: book.title,
        className: classLabel(appState.classId)
      });
      if (data.found && isRealAnswer(data.answer)) return data.answer;
    }
    const texts = files.filter((file) => fileKind(file) === 'txt');
    for (const file of texts) {
      const text = new TextDecoder('utf-8').decode(file.bytes instanceof ArrayBuffer ? file.bytes : new Uint8Array(file.bytes));
      const windows = [];
      for (let i = 0; i < text.length && windows.length < 8; i += 7000) windows.push(text.slice(i, i + 8000));
      for (let index = 0; index < windows.length; index += 1) {
        if (appState.aiRequestId !== requestId) return 'stopped';
        setVoiceSearchStatus('আপলোড করা লেখা পড়া হচ্ছে…');
        const data = await postJson('/api/read-book', {
          action: 'answer-text',
          text: windows[index],
          question: query,
          bookTitle: book.title,
          className: classLabel(appState.classId)
        });
        if (data.found && isRealAnswer(data.answer)) return data.answer;
      }
    }
    return '';
  }
  window.saveAdminBookFile = async function (event) {
    if (event) event.preventDefault();
    const bookId = document.getElementById('fileBookSelect')?.value || '';
    const input = document.getElementById('bookFileInput');
    const picked = Array.from(input?.files || []);
    if (!bookId) return alert('বই নির্বাচন করুন।');
    if (!picked.length) return alert('PDF, JPG বা TXT ফাইল বেছে নিন।');
    const accepted = picked.filter((file) => fileKind(file)).slice(0, 16);
    if (!accepted.length) return alert('শুধু PDF, JPG, PNG, WEBP বা TXT ফাইল দেওয়া যাবে।');
    if (accepted.some((file) => file.size > 80 * 1024 * 1024)) return alert('একটি ফাইল ৮০ মেগাবাইটের বেশি। ছোট করে আবার দিন।');
    const stored = [];
    for (const file of accepted) {
      stored.push({ name: file.name, type: file.type || '', kind: fileKind(file), bytes: await file.arrayBuffer() });
    }
    await putBookFiles(bookId, stored);
    const book = (catalog.books || []).find((item) => item.id === bookId);
    if (book) {
      book.fileName = stored.map((file) => file.name).join(', ');
      book.published = true;
      try { await saveCatalog(); } catch (_) {}
    }
    localFiles[bookId] = stored.map((file) => file.name).join(', ');
    if (input) input.value = '';
    renderSchoolApp();
    alert('ফাইল সেভ হয়েছে। এখন খুঁজুন পেজে এই বই বেছে প্রশ্ন করুন। বড় PDF হলে উত্তর আসতে এক-দুই মিনিট লাগতে পারে। ফাইল এই ব্রাউজারে সেভ থাকে।');
  };

  async function answerFromAddedBook(bookId, query) {
    const book = appBook(bookId);
    if (!book) return setVoiceSearchStatus('বইটি পাওয়া যায়নি।');
    const requestId = beginAnswer(book, query);
    try {
      const saved = usefulSavedAnswer(bookId, query);
      if (isRealAnswer(saved)) {
        setVoiceSearchStatus('');
        finishAnswer(requestId, saved);
        return;
      }
      setVoiceSearchStatus(isEnglishBook(bookId) ? 'Creating an answer from this book…' : 'নির্বাচিত বইয়ের সমাধান থেকে উত্তর তৈরি হচ্ছে…');
      const taught = await answerFromSavedBook(book, query);
      if (appState.aiRequestId !== requestId) return;
      if (isRealAnswer(taught)) {
        setVoiceSearchStatus('');
        finishAnswer(requestId, taught);
        return;
      }
      let localAnswer = '';
      let localError = '';
      try {
        localAnswer = await answerFromLocalFile(book, query, requestId);
      } catch (error) {
        localError = error.message || '';
      }
      if (localAnswer === 'stopped') return;
      if (isRealAnswer(localAnswer)) {
        setVoiceSearchStatus('');
        finishAnswer(requestId, localAnswer);
        return;
      }
      let linkError = '';
      if (book.link) {
        const hints = hintPages(bookId, query);
        try {
          setVoiceSearchStatus('সেভ করা লিংক থেকে বই খোলা হচ্ছে… বড় PDF হলে একটু সময় লাগবে।');
          let data = await postJson('/api/read-book', {
            action: 'open',
            url: book.link,
            question: query,
            bookTitle: book.title,
            className: classLabel(appState.classId),
            pageHint: hints[0] || 0
          });
          if (data.fileUri && !isRealAnswer(data.answer)) {
            setVoiceSearchStatus('বইয়ের পাতা পড়ে উত্তর খোঁজা হচ্ছে…');
            data = await postJson('/api/read-book', {
              action: 'answer',
              url: book.link,
              fileUri: data.fileUri,
              mimeType: data.mimeType || 'application/pdf',
              fileName: data.fileName || '',
              question: query,
              bookTitle: book.title,
              className: classLabel(appState.classId),
              pageHint: hints[0] || 0
            });
          }
          if (data.found && isRealAnswer(data.answer)) {
            setVoiceSearchStatus('');
            finishAnswer(requestId, data.answer);
            return;
          }
          linkError = data.error || '';
        } catch (error) {
          linkError = error.message || '';
        }
        try {
          setVoiceSearchStatus('লিংক থেকে PDF নিয়ে পাতা ধরে পড়া হচ্ছে…');
          const bytes = await Promise.race([
            downloadBookPdf(book.link),
            sleep(40000).then(() => { throw new Error('লিংক থেকে PDF ডাউনলোড শেষ হয়নি।'); })
          ]);
          const downloaded = await answerFromPdfFile(book, query, requestId, bytes);
          if (downloaded === 'stopped') return;
          if (isRealAnswer(downloaded)) {
            setVoiceSearchStatus('');
            finishAnswer(requestId, downloaded);
            return;
          }
        } catch (_) {}
      }
      const uploaded = Boolean(localFiles[bookId]);
      throw new Error([localError, linkError].filter(Boolean).join(' ') + (uploaded
        ? ' আপলোড করা ফাইলের পাতায় এই প্রশ্নের উত্তর পাওয়া যায়নি। প্রশ্নটি এই বইয়ের পাঠ থেকে কিনা দেখুন।'
        : ' নির্বাচিত বইয়ের লিংক থেকে উত্তর আসেনি। সেটিংস থেকে PDF আপলোড করলে খুঁজুন পেজ সেই ফাইল পড়ে উত্তর দেবে।'));
    } catch (error) {
      finishAnswer(requestId, '', error.message || 'AI উত্তর তৈরি করা যায়নি।');
    }
  }

  function solutionContext(bookId) {
    const set = appSet(bookId) || [];
    if (!set.length) return '';
    return set.map((item) => `অধ্যায়: ${plain(item.l)}; পৃষ্ঠা: ${item.p}\nপ্রশ্ন: ${plain(item.t)}\nপাঠ্যতথ্য: ${plain(item.a)}`).join('\n\n').slice(0, 100000);
  }

  async function refreshAdminSession() {
    try {
      const response = await fetch('/api/admin-session', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      adminSession = { checked: true, loggedIn: Boolean(data.loggedIn), id: data.id || '' };
    } catch (_) {
      adminSession = { checked: true, loggedIn: false, id: '' };
    }
    renderNav();
  }
  function catalogTime(value) {
    const time = Date.parse(value && value.updatedAt);
    return Number.isFinite(time) ? time : 0;
  }
  function catalogHasBooks(value) {
    return Boolean(value && ((value.classes || []).length || (value.books || []).length));
  }
  function newerCatalog(left, right) {
    if (!catalogHasBooks(left)) return catalogHasBooks(right) ? right : (left || right);
    if (!catalogHasBooks(right)) return left;
    return catalogTime(right) >= catalogTime(left) ? right : left;
  }
  function readStoredCatalog(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  async function loadCatalog() {
    let server = null;
    try {
      const response = await fetch(`/api/catalog?t=${Date.now()}`, { cache: 'no-store' });
      const data = await response.json();
      server = data.catalog || null;
      canPersist = Boolean(data.canPersist);
    } catch (_) {
      canPersist = false;
    }
    catalog = newerCatalog(newerCatalog(server, readStoredCatalog(LOCAL_KEY)), readStoredCatalog(PENDING_KEY)) || catalog;
    if (!canPersist && catalogHasBooks(catalog)) lastWarning = 'বই এই ব্রাউজারে সেভ আছে। অন্য ফোনে দেখাতে Vercel-এ GITHUB_TOKEN লাগবে।';
    syncAppSubjects();
  }
  async function saveCatalog() {
    const sent = catalog;
    const data = await postJson('/api/catalog', { catalog: sent });
    catalog = data.persisted && data.catalog ? data.catalog : sent;
    if (!catalog.updatedAt) catalog.updatedAt = new Date().toISOString();
    lastWarning = data.persisted ? '' : (data.warning || 'সার্ভারে সেভ হয়নি। এই ব্রাউজারে রাখা হয়েছে।');
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(catalog)); } catch (_) {}
    if (data.persisted) localStorage.removeItem(PENDING_KEY);
    else {
      try { localStorage.setItem(PENDING_KEY, JSON.stringify(catalog)); } catch (_) {}
    }
    syncAppSubjects();
    return data;
  }
  window.submitAdminLogin = async function (event) {
    event.preventDefault();
    const status = document.getElementById('loginStatus');
    const id = document.getElementById('adminIdInput')?.value || '';
    const password = document.getElementById('adminPasswordInput')?.value || '';
    if (status) status.textContent = 'লগইন হচ্ছে…';
    try {
      const data = await postJson('/api/admin-login', { id: id, password: password });
      adminSession = { checked: true, loggedIn: true, id: data.id || id };
      if (status) status.textContent = '';
      renderNav();
      appGo('settings', { bookId: null });
    } catch (error) {
      if (status) status.textContent = error.message || 'লগইন হয়নি।';
    }
  };
  window.adminLogout = async function () {
    try { await postJson('/api/admin-logout', {}); } catch (_) {}
    adminSession = { checked: true, loggedIn: false, id: '' };
    renderNav();
    appGo('login', { bookId: null });
  };
  window.setSettingsClass = function (classId) {
    appState.settingsClassId = classId;
    appState.settingsBookId = '';
    if (appState.screen === 'settings') renderSchoolApp();
  };
  window.setSolutionClass = function (classId) {
    appState.solutionClassId = classId;
    appState.solutionBookId = '';
    if (appState.screen === 'settings') renderSchoolApp();
  };
  window.addAdminClass = async function (event) {
    if (event) event.preventDefault();
    const input = document.getElementById('newClassName');
    const name = String(input?.value || '').trim();
    if (name.length < 2) return alert('শ্রেণীর নাম লিখুন।');
    if (allClasses().some((item) => item.name === name)) return alert('এই নামে শ্রেণী আগেই আছে।');
    catalog.classes = (catalog.classes || []).concat({ id: newId('c'), name: name, createdAt: new Date().toISOString() });
    try {
      await saveCatalog();
      appState.settingsClassId = catalog.classes[catalog.classes.length - 1].id;
      renderSchoolApp();
    } catch (error) { alert(error.message); }
  };
  window.addAdminBook = async function (event) {
    if (event) event.preventDefault();
    const classId = document.getElementById('bookClassSelect')?.value || '';
    const title = String(document.getElementById('newBookName')?.value || '').trim();
    if (!classId) return alert('আগে শ্রেণী নির্বাচন করুন।');
    if (title.length < 2) return alert('বইয়ের নাম লিখুন।');
    if (booksForClass(classId).some((book) => book.title === title)) return alert('এই শ্রেণীতে এই নামে বই আছে।');
    const book = { id: newId('b'), classId: classId, title: title, icon: iconFor(title), link: '', preview: '', published: false, createdAt: new Date().toISOString() };
    catalog.books = (catalog.books || []).concat(book);
    appState.settingsClassId = classId;
    appState.settingsBookId = book.id;
    try { await saveCatalog(); renderSchoolApp(); } catch (error) { alert(error.message); }
  };
  window.saveAdminBookUrl = async function (event) {
    if (event) event.preventDefault();
    const bookId = document.getElementById('urlBookSelect')?.value || '';
    const link = safeUrl(document.getElementById('bookUrlInput')?.value || '');
    if (!bookId) return alert('বই নির্বাচন করুন।');
    if (!link) return alert('সঠিক http বা https লিংক দিন।');
    const book = (catalog.books || []).find((item) => item.id === bookId);
    if (!book) {
      if (BUILTIN_IDS.has(bookId)) return alert('আগ থেকে থাকা বইয়ের লিংক বদলানো যাবে না। নতুন বই যোগ করে লিংক দিন।');
      return alert('বইটি পাওয়া যায়নি।');
    }
    book.link = link;
    book.preview = previewFromLink(link);
    book.published = true;
    try {
      await saveCatalog();
      let note = 'লিংক সেভ হয়েছে।';
      try {
        const probe = await postJson('/api/read-book', { action: 'probe', url: link });
        note = 'লিংক সেভ হয়েছে। ' + (probe.message || 'AI এই লিংক পড়তে পারবে।') + (probe.preview ? '\n\nপড়া লেখা: ' + probe.preview : '');
      } catch (probeError) {
        note = 'লিংক সেভ হয়েছে, কিন্তু এখন পড়া যায়নি: ' + (probeError.message || 'লিংক চেক করা যায়নি।');
      }
      renderSchoolApp();
      alert(note);
    } catch (error) { alert(error.message); }
  };
  window.removeAdminClass = async function (classId) {
    if (!confirm('এই শ্রেণী ও তার নতুন বই মুছে ফেলবেন?')) return;
    const bookIds = (catalog.books || []).filter((book) => book.classId === classId).map((book) => book.id);
    catalog.classes = (catalog.classes || []).filter((item) => item.id !== classId);
    catalog.books = (catalog.books || []).filter((book) => book.classId !== classId);
    bookIds.forEach((id) => { if (catalog.solutions) delete catalog.solutions[id]; });
    try { await saveCatalog(); renderSchoolApp(); } catch (error) { alert(error.message); }
  };
  window.removeAdminBook = async function (bookId) {
    if (!confirm('এই বইটি মুছে ফেলবেন?')) return;
    catalog.books = (catalog.books || []).filter((book) => book.id !== bookId);
    if (catalog.solutions) delete catalog.solutions[bookId];
    try { await saveCatalog(); renderSchoolApp(); } catch (error) { alert(error.message); }
  };

  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      script.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('PDF টুল লোড হয়নি।'));
      script.onerror = () => reject(new Error('PDF টুল লোড হয়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।'));
      document.head.appendChild(script);
    });
  }
  function driveDownloadUrls(link) {
    const value = String(link || '');
    const file = value.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
    const id = file ? file[1] : ((value.match(/[?&]id=([^&#]+)/) || [])[1] || '');
    if (!id) return [value];
    return [
      `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`,
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
      value
    ];
  }
  async function downloadBookPdf(link) {
    let lastError = 'বইয়ের PDF ডাউনলোড করা যায়নি। লিংকটি পাবলিক কিনা দেখুন।';
    for (const url of driveDownloadUrls(link)) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === '%PDF') return bytes;
        lastError = 'লিংক থেকে PDF পাওয়া যায়নি। Drive-এ “যে কেউ লিংক দিয়ে দেখতে পারবে” চালু আছে কিনা দেখুন।';
      } catch (_) {
        lastError = 'ব্রাউজার থেকে বই ডাউনলোড করা যায়নি।';
      }
    }
    throw new Error(lastError);
  }
  let openPdfCache = null;
  async function openBookPdf(link) {
    if (openPdfCache && openPdfCache.url === link) return openPdfCache;
    await loadPdfLib();
    const bytes = await downloadBookPdf(link);
    const doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    openPdfCache = { url: link, doc: doc, pageCount: doc.getPageCount() };
    return openPdfCache;
  }
  function uint8ToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  async function slicePagesBase64(doc, start, end) {
    const out = await window.PDFLib.PDFDocument.create();
    const indexes = [];
    for (let page = start; page <= end; page += 1) indexes.push(page - 1);
    const copied = await out.copyPages(doc, indexes);
    copied.forEach((page) => out.addPage(page));
    const bytes = await out.save();
    if (bytes.length > 2400000) return end > start ? null : '';
    return uint8ToBase64(bytes);
  }

  function readJob() {
    try { return JSON.parse(localStorage.getItem(JOB_KEY) || 'null'); } catch (_) { return null; }
  }
  function writeJob(job) {
    try {
      if (!job) localStorage.removeItem(JOB_KEY);
      else localStorage.setItem(JOB_KEY, JSON.stringify(job));
    } catch (_) {}
  }
  function dedupeItems(items) {
    const map = new Map();
    (items || []).forEach((item) => {
      const key = plain(item && item.question).toLowerCase();
      if (!key) return;
      const prev = map.get(key);
      if (!prev || (isWeakAnswer(prev.answer) && !isWeakAnswer(item.answer))) map.set(key, item);
    });
    return Array.from(map.values());
  }

  function recordsFromItems(items) {
    const groups = new Map();
    dedupeItems(items).forEach((item) => {
      const chapter = item.chapter || `পৃষ্ঠা ${item.page || 1}`;
      if (!groups.has(chapter)) groups.set(chapter, []);
      groups.get(chapter).push(item);
    });
    const records = [];
    groups.forEach((list, chapter) => {
      list.forEach((item, index) => {
        records.push({ p: item.page || 0, l: chapter, q: String(index + 1), t: item.question, a: item.answer, type: item.type || 'অনুশীলনী' });
      });
    });
    return records;
  }
  function progressHtml(job, message) {
    const done = Math.max(0, (job.nextPage || 1) - 1);
    const total = job.pageCount || 1;
    const pct = Math.max(4, Math.min(100, Math.round((done / total) * 100)));
    const unit = job.kind === 'html' ? 'অংশ' : 'পৃষ্ঠা';
    return `<div class="solution-progress"><b>${esc(message)}</b><div class="solution-bar"><span style="width:${pct}%"></span></div><small>${unit} ${bnNum(Math.min(done + 1, total))} / ${bnNum(total)} · এ পর্যন্ত ${bnNum((job.items || []).length)}টি প্রশ্ন</small><div style="margin-top:8px"><button type="button" class="admin-inline-button secondary" onclick="cancelSolutionJob()">থামান</button></div></div>`;
  }
  async function solveUploaded(job, start, end, doc) {
    const sendSlice = async (from, to) => {
      const pdfBase64 = await slicePagesBase64(doc, from, to);
      if (!pdfBase64) return { items: [] };
      return postJson('/api/solution-job', {
        action: 'solve-upload',
        pdfBase64: pdfBase64,
        startPage: from,
        endPage: to,
        bookTitle: job.title,
        className: job.className
      });
    };
    const combined = await slicePagesBase64(doc, start, end);
    if (combined) return sendSlice(start, end);
    const items = [];
    for (let page = start; page <= end; page += 1) {
      if (solutionCancel) break;
      try {
        const one = await sendSlice(page, page);
        items.push.apply(items, one.items || []);
      } catch (_) {}
    }
    return { items: items };
  }
  window.cancelSolutionJob = function () { solutionCancel = true; };
  window.resumeSolutionJob = function () { startSolutionJob(true); };
  let solutionChunks = [];
  async function finishSolution(job, box) {
    const records = recordsFromItems((job.items || []).filter((item) => item && item.question && !isWeakAnswer(item.answer)));
    if (!records.length) {
      writeJob(null);
      if (box) box.innerHTML = '<p class="admin-note error">বই থেকে প্রকৃত উত্তরসহ প্রশ্ন পাওয়া যায়নি। PDF আপলোড আছে কিনা দেখুন, তারপর “খালি উত্তর পূরণ করুন” বা আবার “সমাধান তৈরী করুন” চাপুন।</p>';
      return;
    }
    catalog.solutions = Object.assign({}, catalog.solutions || {}, { [job.bookId]: records });
    try {
      await saveCatalog();
      writeJob(null);
      if (box) box.innerHTML = '<p class="admin-note">' + bnNum(records.length) + 'টি প্রশ্নের প্রকৃত উত্তরসহ সমাধান বই সংরক্ষণ হয়েছে। শ্রেণী পেজের সমাধানে এখন এটি দেখা যাবে।</p>';
    } catch (error) {
      writeJob(job);
      if (box) box.innerHTML = '<p class="admin-note error">সমাধান তৈরী হয়েছে, কিন্তু সেভ হয়নি: ' + esc(error.message) + '</p>';
    }
  }

  async function askSolutionSlice(job, from, to, pdfBase64) {
    try {
      return await postJson('/api/solution-job', { pdfBase64: pdfBase64, startPage: from, endPage: to, bookTitle: job.title, className: job.className });
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        return await postJson('/api/solution-job', { pdfBase64: pdfBase64, startPage: from, endPage: to, bookTitle: job.title, className: job.className });
      } catch (_) {
        return { items: [] };
      }
    }
  }
  async function solveLocalPdf(job, bytes, box) {
    await loadPdfLib();
    let doc;
    try {
      doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch (_) {
      throw new Error('এই ব্রাউজারে বড় PDF খোলা যায়নি। কম্পিউটারের Chrome দিয়ে আবার চেষ্টা করুন।');
    }
    job.kind = 'pdf';
    job.pageCount = Math.min(doc.getPageCount(), 180);
    if (job.nextPage < 1 || job.nextPage > job.pageCount) job.nextPage = 1;
    while (job.nextPage <= job.pageCount) {
      if (solutionCancel) {
        writeJob(job);
        if (box) box.innerHTML = '<p class="admin-note warn">সমাধান তৈরী থামানো হয়েছে। পরে “চালিয়ে যান” চাপতে পারবেন।</p>';
        return;
      }
      const start = job.nextPage;
      const from = Math.max(1, start - 4);
      const end = Math.min(job.pageCount, start + 3);
      if (box) box.innerHTML = progressHtml(job, job.title + ' — পুরো বই থেকে সমাধান তৈরী হচ্ছে…');
      const slice = await fitSlice(doc, from, end, end);
      if (slice) {
        const data = await askSolutionSlice(job, slice.from, slice.to, slice.b64);
        const tagged = (data.items || []).map((item) => Object.assign({}, item, {
          sliceFrom: slice.from,
          sliceTo: slice.to,
          page: Number(item.page) || slice.from
        }));
        job.items = dedupeItems((job.items || []).concat(tagged));
      }
      job.nextPage = end + 1;
      writeJob(job);
    }
    if (solutionCancel) return;
    const weakCount = (job.items || []).filter((item) => isWeakAnswer(item.answer)).length;
    if (weakCount) {
      if (box) box.innerHTML = progressHtml(job, job.title + ' — ' + bnNum(weakCount) + 'টি প্রশ্নের উত্তর বইয়ের পাঠ থেকে পূরণ হচ্ছে…');
      await fillWeakItems(job, doc, box);
      writeJob(job);
    }
    if (solutionCancel) {
      if (box) box.innerHTML = '<p class="admin-note warn">সমাধান তৈরী থামানো হয়েছে। পরে “চালিয়ে যান” চাপতে পারবেন।</p>';
      return;
    }
    job.items = (job.items || []).filter((item) => item && item.question && !isWeakAnswer(item.answer));
    await finishSolution(job, box);
  }

  async function solveLocalImages(job, images, box) {
    job.kind = 'html';
    job.pageCount = images.length;
    if (job.nextPage < 1 || job.nextPage > job.pageCount) job.nextPage = 1;
    while (job.nextPage <= job.pageCount) {
      if (solutionCancel) {
        writeJob(job);
        if (box) box.innerHTML = '<p class="admin-note warn">সমাধান তৈরী থামানো হয়েছে। পরে “চালিয়ে যান” চাপতে পারবেন।</p>';
        return;
      }
      if (box) box.innerHTML = progressHtml(job, `${job.title} — ছবি থেকে সমাধান তৈরী হচ্ছে…`);
      const image = await imageBase64(images[job.nextPage - 1]);
      const previousImage = job.nextPage > 1 ? await imageBase64(images[job.nextPage - 2]) : '';
      let data = { items: [] };
      if (image) {
        try {
          data = await postJson('/api/read-book', { action: 'solve-image', imageBase64: image, previousImageBase64: previousImage, mimeType: 'image/jpeg', bookTitle: job.title, className: job.className, part: job.nextPage });
        } catch (_) {}
      }
      job.items = dedupeItems((job.items || []).concat(data.items || []));
      job.nextPage += 1;
      writeJob(job);
    }
    if (!solutionCancel) await finishSolution(job, box);
  }
  async function solveLocalText(job, files, box) {
    const text = files.map((file) => new TextDecoder('utf-8').decode(file.bytes instanceof ArrayBuffer ? file.bytes : new Uint8Array(file.bytes))).join('\n');
    solutionChunks = [];
    for (let i = 0; i < text.length && solutionChunks.length < 40; i += 6500) solutionChunks.push(text.slice(i, i + 7500));
    job.kind = 'html';
    job.pageCount = solutionChunks.length;
    if (job.nextPage < 1 || job.nextPage > job.pageCount) job.nextPage = 1;
    while (job.nextPage <= job.pageCount) {
      if (solutionCancel) {
        writeJob(job);
        if (box) box.innerHTML = '<p class="admin-note warn">সমাধান তৈরী থামানো হয়েছে। পরে “চালিয়ে যান” চাপতে পারবেন।</p>';
        return;
      }
      if (box) box.innerHTML = progressHtml(job, `${job.title} — লেখা থেকে সমাধান তৈরী হচ্ছে…`);
      let data = { items: [] };
      try {
        data = await postJson('/api/read-book', { action: 'solve-plain', text: solutionChunks[job.nextPage - 1] || '', bookTitle: job.title, className: job.className, part: job.nextPage });
      } catch (_) {}
      job.items = dedupeItems((job.items || []).concat(data.items || []));
      job.nextPage += 1;
      writeJob(job);
    }
    if (!solutionCancel) await finishSolution(job, box);
  }
  window.cancelSolutionJob = function () { solutionCancel = true; };
  window.resumeSolutionJob = function () { startSolutionJob(true); };

  window.repairSavedAnswers = async function () {
    if (!adminSession.loggedIn) return alert('আগে লগইন করুন।');
    const classId = document.getElementById('solutionClassSelect')?.value || appState.solutionClassId || '';
    const bookId = document.getElementById('solutionBookSelect')?.value || appState.solutionBookId || '';
    const book = findBook(bookId) || appBook(bookId);
    const records = (catalog.solutions && catalog.solutions[bookId]) || [];
    if (!book || !records.length) return alert('এই বইয়ের সংরক্ষিত সমাধান নেই। আগে সমাধান তৈরী করুন।');
    const weak = records.filter((item) => isWeakAnswer(item.a));
    if (!weak.length) return alert('খালি উত্তর নেই। সংরক্ষিত উত্তরগুলো আগেই আছে।');
    let stored = null;
    try { stored = await getBookFiles(bookId); } catch (_) {}
    const pdf = stored && stored.files ? stored.files.find((file) => fileKind(file) === 'pdf') : null;
    if (!pdf) return alert('খালি উত্তর পূরণ করতে এই ব্রাউজারে বইয়ের PDF আপলোড করে রাখুন। ফাইল এই ব্রাউজারে সেভ থাকে।');
    if (!confirm(bnNum(weak.length) + 'টি খালি উত্তর আপলোড করা বই থেকে পূরণ হবে। পুরো সমাধান আবার বানাতে হবে না। পেজ বন্ধ করবেন না। চালু করবেন?')) return;
    const box = document.getElementById('solutionProgress');
    solutionCancel = false;
    const job = {
      bookId: bookId,
      classId: classId,
      title: book.title,
      className: classLabel(classId),
      kind: 'pdf',
      pageCount: 0,
      nextPage: 1,
      items: records.map((item) => ({ page: item.p || 1, chapter: item.l, type: item.type || 'অনুশীলনী', question: item.t, answer: item.a }))
    };
    try {
      await loadPdfLib();
      const doc = await window.PDFLib.PDFDocument.load(pdf.bytes, { ignoreEncryption: true });
      job.pageCount = Math.min(doc.getPageCount(), 180);
      job.nextPage = job.pageCount + 1;
      if (box) box.innerHTML = progressHtml(job, job.title + ' — খালি উত্তর বই থেকে পূরণ হচ্ছে…');
      await fillWeakItems(job, doc, box);
      if (solutionCancel) {
        if (box) box.innerHTML = '<p class="admin-note warn">পূরণ থামানো হয়েছে। আবার “খালি উত্তর পূরণ করুন” চাপুন।</p>';
        return;
      }
      const left = job.items.filter((item) => isWeakAnswer(item.answer)).length;
      job.items = job.items.filter((item) => item && item.question && !isWeakAnswer(item.answer));
      await finishSolution(job, box);
      if (left && box) box.innerHTML += '<p class="admin-note warn">' + bnNum(left) + 'টি প্রশ্নের উত্তর এই পাতায় মেলেনি, তাই সেগুলো সমাধান বইয়ে রাখা হয়নি।</p>';
    } catch (error) {
      if (box) box.innerHTML = '<p class="admin-note error">' + esc(error.message || 'উত্তর পূরণ করা যায়নি।') + '</p>';
    }
  };

  window.startSolutionJob = async function (resume) {
    if (!adminSession.loggedIn) return alert('আগে লগইন করুন।');
    let job = resume ? readJob() : null;
    let pickedFiles = [];
    if (!job) {
      const classId = document.getElementById('solutionClassSelect')?.value || '';
      const bookId = document.getElementById('solutionBookSelect')?.value || '';
      const book = findBook(bookId) || appBook(bookId);
      let stored = null;
      try { stored = await getBookFiles(bookId); } catch (_) {}
      pickedFiles = stored && stored.files ? stored.files : [];
      const hasLocal = pickedFiles.some((file) => fileKind(file));
      if (!classId || !book || (!book.link && !hasLocal)) return alert('লিংক বা PDF/JPG/TXT ফাইলসহ একটি বই নির্বাচন করুন।');
      if (!confirm('পুরো বইয়ের সমাধান তৈরী হতে ১০–২০ মিনিট লাগতে পারে। পেজ বন্ধ করবেন না। চালু করবেন?')) return;
      job = { bookId: bookId, classId: classId, url: book.link || '', title: book.title, className: classLabel(classId), kind: hasLocal ? 'local' : '', pageCount: 0, nextPage: 1, items: [], fileUri: '' };
    } else {
      try {
        const stored = await getBookFiles(job.bookId);
        pickedFiles = stored && stored.files ? stored.files : [];
      } catch (_) {}
    }
    solutionCancel = false;
    const box = document.getElementById('solutionProgress');
    const pdf = pickedFiles.find((file) => fileKind(file) === 'pdf');
    if (pdf) {
      if (box) box.innerHTML = '<div class="solution-progress">আপলোড করা PDF খোলা হচ্ছে… পুরো বই দেখা হবে।</div>';
      try { await solveLocalPdf(job, pdf.bytes, box); }
      catch (error) { if (box) box.innerHTML = `<p class="admin-note error">${esc(error.message || 'সমাধান তৈরী করা যায়নি।')}</p>`; }
      return;
    }
    const images = pickedFiles.filter((file) => fileKind(file) === 'image');
    if (images.length) {
      if (box) box.innerHTML = '<div class="solution-progress">আপলোড করা ছবি থেকে সমাধান তৈরী হচ্ছে…</div>';
      await solveLocalImages(job, images, box);
      return;
    }
    const texts = pickedFiles.filter((file) => fileKind(file) === 'txt');
    if (texts.length) {
      await solveLocalText(job, texts, box);
      return;
    }
    if (!job.url) {
      if (box) box.innerHTML = '<p class="admin-note error">এই বইয়ে লিংক বা ফাইল নেই।</p>';
      return;
    }
    if (box) box.innerHTML = '<div class="solution-progress">সেভ করা লিংক থেকে বই পড়া হচ্ছে…</div>';
    try {
      const prep = await postJson('/api/read-book', { action: 'prepare', url: job.url, bookTitle: job.title, className: job.className });
      job.kind = prep.kind || 'pdf';
      if (job.kind === 'html') {
        solutionChunks = prep.chunks || [];
        job.pageCount = solutionChunks.length;
      } else {
        solutionChunks = [];
        job.pageCount = Math.min(prep.pageCount || 120, 220);
        job.fileUri = prep.fileUri || job.fileUri || '';
        job.mimeType = prep.mimeType || 'application/pdf';
      }
      if (!job.pageCount) throw new Error('এই লিংক থেকে পুরো বই পড়া যায়নি। সেটিংস থেকে PDF আপলোড করলে পুরো সমাধান তৈরী হবে।');
      if (job.nextPage < 1) job.nextPage = 1;
    } catch (error) {
      if (box) box.innerHTML = `<p class="admin-note error">${esc(error.message)}</p>`;
      return;
    }
    while (job.nextPage <= job.pageCount) {
      if (solutionCancel) {
        writeJob(job);
        if (box) box.innerHTML = '<p class="admin-note warn">সমাধান তৈরী থামানো হয়েছে। পরে “চালিয়ে যান” চাপতে পারবেন।</p>';
        return;
      }
      if (box) box.innerHTML = progressHtml(job, `${job.title} থেকে পুরো সমাধান তৈরী হচ্ছে…`);
      try {
        let data;
        if (job.kind === 'html') {
          data = await postJson('/api/read-book', { action: 'solve-text', url: job.url, text: solutionChunks[job.nextPage - 1] || '', bookTitle: job.title, className: job.className, part: job.nextPage });
          job.nextPage += 1;
        } else {
          const start = job.nextPage;
          const from = Math.max(1, start - 4);
          const end = Math.min(job.pageCount, start + 3);
          data = await postJson('/api/read-book', { action: 'solve-pdf', url: job.url, fileUri: job.fileUri || '', mimeType: job.mimeType || 'application/pdf', startPage: from, endPage: end, bookTitle: job.title, className: job.className });
          job.nextPage = end + 1;
        }
        job.items = dedupeItems((job.items || []).concat(data.items || []));
        writeJob(job);
      } catch (error) {
        writeJob(job);
        if (box) box.innerHTML = `<p class="admin-note error">${esc(error.message)} এ পর্যন্ত ${bnNum((job.items || []).length)}টি প্রশ্ন রাখা আছে। “চালিয়ে যান” চাপুন।</p>`;
        return;
      }
    }
    job.items = (job.items || []).filter((item) => item && item.question && !isWeakAnswer(item.answer));
    await finishSolution(job, box);
  };

  renderNav();
  appState = appRouteFromHash();
  appWriteUrl(true);
  renderSchoolApp();
  refreshAdminSession().then(loadCatalog).then(refreshLocalFiles).then(() => {
    renderNav();
    const next = appRouteFromHash();
    if (next.screen !== 'login' && next.screen !== 'settings') appState = Object.assign({}, appState, next);
    renderSchoolApp();
  });
})();
