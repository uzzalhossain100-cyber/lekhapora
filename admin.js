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
    return builtin.concat(custom).filter((book) => !publishedOnly || book.builtin || book.link);
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
  function customBookScreen() {
    const book = appBook(appState.bookId);
    if (!book) return classesMarkup();
    const name = esc(classLabel(appState.classId || book.classId || 'class-3'));
    const set = appSet(appState.bookId) || [];
    if (appState.screen === 'reader') {
      const preview = book.preview || book.link;
      return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${esc(book.title)} › মূল বই`)}<div class="reader-page"><div class="reader-frame">${preview ? `<iframe src="${esc(preview)}" title="${esc(book.title)} সম্পূর্ণ বই" loading="eager"></iframe>` : '<p style="padding:16px">এই বইয়ের প্রিভিউ লিংক নেই।</p>'}</div><aside class="reader-side"><div class="side-title"><h2>অনুশীলনী সূচি</h2><p>প্রশ্নে ক্লিক করে সমাধানে যান</p></div><div class="side-scroll">${set.length ? set.map((item, index) => `<button class="reader-question" onclick="appGo('solutions',{bookId:'${book.id}',mode:'solutions',solutionIndex:${index}})"><small>পৃষ্ঠা ${bnNum(item.p)} · প্রশ্ন ${esc(item.q)}</small>${item.l}</button>`).join('') : '<p style="padding:10px;color:#648075">এই বইয়ের সমাধান এখনো তৈরি হয়নি।</p>'}</div>${book.link ? `<a class="reader-fallback" href="${esc(book.link)}" target="_blank" rel="noopener">↗ নতুন ট্যাবে বড় করে পড়ুন</a>` : ''}</aside></div></div></div>`;
    }
    const index = Number.isInteger(appState.solutionIndex) && set[appState.solutionIndex] ? appState.solutionIndex : 0;
    if (!set.length) {
      return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${esc(book.title)} › সমাধান`)}<div class="app-panel"><div class="marked-empty"><div>💡</div><h2>সমাধান এখনো সংরক্ষণ হয়নি</h2><p>এডমিন সেটিংসের “সমাধান তৈরী করুন” থেকে এই বইয়ের সমাধান বই তৈরি হবে।</p></div></div></div></div>`;
    }
    return `<div class="school-app"><div class="app-shell">${appHeader(`<b>${name}</b> › ${esc(book.title)} › সমাধান`)}<div class="solution-page"><aside class="solution-side"><div class="side-title"><h2>সমাধান সূচি</h2><p>যে প্রশ্নটি দেখতে চান ক্লিক করুন</p></div><div class="side-scroll">${set.map((item, itemIndex) => `<button class="solution-jump ${itemIndex === index ? 'active' : ''}" onclick="appGo('solutions',{bookId:'${book.id}',mode:'solutions',solutionIndex:${itemIndex}})">পৃষ্ঠা ${bnNum(item.p)} · প্রশ্ন ${esc(item.q)}<br><span style="font-weight:700;font-size:11px">${item.l}</span></button>`).join('')}</div></aside><main class="solution-main"><button class="solution-return" onclick="appBack()">← ব্যাক</button><div class="solution-header"><h1>${esc(book.title)} — সমাধান</h1><p>আগে চেষ্টা করো, না পারলে ধাপে ধাপে সমাধান দেখো।</p></div><div class="solution-tip">💡 এটি সংরক্ষিত সমাধান বই। প্রয়োজনীয় প্রশ্ন চিহ্নিত করতে নিচের টিক ব্যবহার করুন।</div>${set.map((item, itemIndex) => `<article id="full-solution-${itemIndex}" class="standard-card ${itemIndex === index ? 'active' : ''}"><div class="standard-card-head"><span class="pno">পৃষ্ঠা ${bnNum(item.p)}</span><div><strong>${item.l} · প্রশ্ন ${esc(item.q)}</strong><small>${esc(item.type || appQuestionType(item))}</small></div></div><div class="standard-question"><b>মূল বইয়ের প্রশ্ন · প্রশ্ন ${esc(item.q)}</b><div class="standard-question-text">${item.t}</div></div><div class="standard-answer-label">সমাধান</div><div class="standard-answer">${solutionAnswerMarkup(item, book.id, itemIndex, true)}</div></article>`).join('')}</main></div></div></div>`;
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
    const bookItems = classBooks.map((book) => `<div class="admin-list-item"><div><b>${book.icon || '📘'} ${esc(book.title)}</b><small>${book.link ? 'লিংক সেভ হয়েছে' : 'এখনো URL দেওয়া হয়নি'} ${bookHasSolutions(book) ? '· সমাধান আছে' : ''}</small></div>${book.builtin ? '' : `<button type="button" onclick="removeAdminBook('${book.id}')">মুছুন</button>`}</div>`).join('');
    const job = readJob();
    const resume = job ? `<p class="admin-note">অসমাপ্ত সমাধান আছে: ${esc(job.title || 'বই')} · পৃষ্ঠা ${bnNum(job.nextPage)}/${bnNum(job.pageCount)}। <button type="button" class="admin-inline-button" onclick="resumeSolutionJob()">চালিয়ে যান</button></p>` : '';
    return `<div class="school-app"><div class="admin-wrap admin-stack">${appHeader('<b>সেটিংস</b>')}<div class="admin-card"><div class="subject-heading"><h1>এডমিন সেটিংস</h1><p>লগইন: ${esc(adminSession.id || 'Uzzal')}</p></div><div class="admin-form"><button type="button" class="secondary" onclick="adminLogout()">লগআউট</button></div>${warning}</div>
      <section class="admin-card"><h2>নতুন শ্রেণী যোগ করুন</h2><p>শ্রেণীর নাম লিখে যোগ করুন। যোগ করা শ্রেণী শ্রেণী পেজে দেখা যাবে।</p><form class="admin-form" onsubmit="addAdminClass(event)"><input id="newClassName" placeholder="যেমন: চতুর্থ শ্রেণী" aria-label="নতুন শ্রেণীর নাম"><button type="submit">শ্রেণী যোগ করুন</button></form><div class="admin-list">${classItems}</div></section>
      <section class="admin-card"><h2>বই যোগ করুন</h2><p>শ্রেণী বেছে নিয়ে বইয়ের নাম যোগ করুন। তারপর নিচের ড্রপডাউন থেকে বই বেছে URL সেভ করুন।</p><form class="admin-form" onsubmit="addAdminBook(event)"><select id="bookClassSelect" onchange="setSettingsClass(this.value)">${optionList(classes, selectedClass, 'শ্রেণী নির্বাচন')}</select><input id="newBookName" placeholder="বইয়ের নাম" aria-label="বইয়ের নাম"><button type="submit">বইয়ের নাম যোগ করুন</button></form>
      ${urlBooks.length ? `<form class="admin-form" onsubmit="saveAdminBookUrl(event)"><select id="urlBookSelect">${optionList(urlBooks, selectedBook, 'বই নির্বাচন')}</select><input id="bookUrlInput" placeholder="বইয়ের ওয়েবসাইট, Google Drive বা PDF লিংক" aria-label="বইয়ের URL"><button class="warn" type="submit">URL সেভ করুন</button></form>` : '<p class="admin-note">এই শ্রেণীতে বইয়ের নাম যোগ করলে এখানে বইয়ের ড্রপডাউন আসবে।</p>'}
      <div class="admin-list">${bookItems || '<p class="admin-note">এই শ্রেণীতে এখনো নতুন বই নেই।</p>'}</div></section>
      <section class="admin-card"><h2>সমাধান তৈরী করুন</h2><p>শ্রেণী ও বই বেছে নিয়ে বাটনে চাপুন। সেভ করা ওয়েবসাইট, Google Drive বা PDF থেকে অনুশীলনী অধ্যায়ভিত্তিক তুলে উত্তরসহ সমাধান বই সংরক্ষণ হবে। লিংকটি সবার জন্য খোলা থাকতে হবে।</p><div class="admin-form"><select id="solutionClassSelect" onchange="setSolutionClass(this.value)">${optionList(classes, solutionClass, 'শ্রেণী নির্বাচন')}</select><select id="solutionBookSelect">${optionList(solutionBooks, solutionBook, 'বই নির্বাচন')}</select><button type="button" onclick="startSolutionJob(false)">সমাধান তৈরী করুন</button></div>${resume}<div id="solutionProgress"></div></section></div></div>`;
  }

  window.renderSchoolApp = function () {
    syncAppSubjects();
    const root = document.getElementById('schoolApp');
    if (!root) return;
    const screen = appState.screen;
    if (screen === 'login') { root.innerHTML = loginMarkup(); return; }
    if (screen === 'settings') { root.innerHTML = settingsMarkup(); return; }
    if (screen === 'classes') { root.innerHTML = classesMarkup(); return; }
    if (screen === 'sectors') { root.innerHTML = sectorsMarkup(); return; }
    if (screen === 'books') { root.innerHTML = booksMarkup(); return; }
    if ((screen === 'reader' || screen === 'solutions') && appState.classId && appState.classId !== 'class-3') {
      root.innerHTML = customBookScreen();
      if (screen === 'solutions') setTimeout(() => { const el = document.getElementById(`full-solution-${appState.solutionIndex || 0}`); if (el) el.scrollIntoView({ block: 'nearest' }); }, 30);
      return;
    }
    if ((screen === 'reader' || screen === 'solutions') && appState.bookId && !BUILTIN_IDS.has(appState.bookId)) {
      root.innerHTML = customBookScreen();
      return;
    }
    originalRenderSchoolApp();
  };

  function searchFilters() {
    const classes = allClasses();
    const classId = appState.classId || '';
    const books = classId ? booksForClass(classId, { publishedOnly: true }) : [];
    return `<div class="search-filters"><label>শ্রেণী<select id="searchClassSelect" onchange="setSearchClass(this.value)">${optionList(classes, classId, 'শ্রেণী নির্বাচন করুন')}</select></label><label>বই<select id="searchBookSelect" onchange="setSearchBook(this.value)" ${classId ? '' : 'disabled'}>${optionList(books, appState.answerBookId || '', classId ? 'বই নির্বাচন করুন' : 'আগে শ্রেণী নির্বাচন করুন')}</select></label></div>`;
  }
  window.searchPageMarkup = function () {
    const query = appState.searchQuery || '';
    const ready = Boolean(String(query).trim() && appState.classId && appState.answerBookId);
    return `<div class="school-app"><div class="app-shell search-page">${appHeader('<b>খুঁজুন</b>')}<div class="app-panel"><div class="subject-heading"><h1>প্রশ্ন খুঁজুন</h1><p>প্রথমে শ্রেণী, তারপর সেই শ্রেণীর বই নির্বাচন করুন। প্রশ্ন লিখুন বা ভয়েস দিন, তারপর নতুন প্রশ্ন তৈরী করুন চাপুন।</p></div>${searchFilters()}<div class="book-search-bar"><label class="search-field"><span>🔎</span><input id="bookSearchInput" value="${esc(query)}" oninput="activateGenerateAnswerButtonFromInput(this);setBookSearchQuery(this.value)" onkeyup="activateGenerateAnswerButtonFromInput(this)" placeholder="প্রশ্ন লিখুন…" autocomplete="off" aria-label="প্রশ্ন খুঁজুন"></label><div class="book-search-actions"><button class="voice-search-button" type="button" onclick="startVoiceBookSearch()" aria-label="ভয়েস দিয়ে প্রশ্ন খুঁজুন">🎙️ <span>ভয়েস</span></button><button id="generateAnswerButton" class="generate-answer-button" type="button" onclick="createBookAnswer()" ${ready ? '' : 'disabled'}>নতুন প্রশ্ন তৈরী করুন</button></div></div><p id="voiceSearchStatus" class="voice-search-status">মাইক্রোফোনে অনুমতি দিয়ে প্রশ্ন বলেও তৈরি করতে পারেন।</p><div id="answerBookPicker"></div><div id="generatedAnswerContainer">${generatedBookAnswerMarkup(query)}</div><div id="searchDynamicContent">${searchResultContentMarkup(query)}</div></div></div></div>`;
  };
  window.searchResultContentMarkup = function (query) {
    if (!appState.classId || !appState.answerBookId) return '<div class="search-start"><div>📚</div><h2>আগে শ্রেণী ও বই নির্বাচন করুন</h2><p>তারপর প্রশ্ন লিখুন বা ভয়েস দিন এবং “নতুন প্রশ্ন তৈরী করুন” চাপুন।</p></div>';
    if (!query) return '<div class="search-start"><div>🔎</div><h2>প্রশ্ন লিখে অথবা বলে খুঁজুন</h2><p>নির্বাচিত বই থেকে প্রশ্ন লিখলে সংরক্ষিত সমাধানও এখানে দেখা যাবে।</p></div>';
    const results = searchBookAnswers(query, appState.answerBookId);
    return results.length ? `<div class="search-result-count">${bnNum(results.length)}টি প্রাসঙ্গিক প্রশ্ন ও উত্তর পাওয়া গেছে</div><div class="search-result-list">${results.map(searchResultMarkup).join('')}</div>` : '<div class="search-start"><div>📚</div><h2>সংরক্ষিত সমাধানে এই প্রশ্নের মিল পাওয়া যায়নি</h2><p>“নতুন প্রশ্ন তৈরী করুন” চাপলে নির্বাচিত বই থেকে AI উত্তর তৈরি করবে।</p></div>';
  };
  window.updateGenerateAnswerButton = function (query) {
    const button = document.getElementById('generateAnswerButton');
    if (!button) return;
    const enabled = Boolean(String(query || '').trim() && appState.classId && appState.answerBookId);
    button.disabled = !enabled;
    button.toggleAttribute('disabled', !enabled);
    button.setAttribute('aria-disabled', String(!enabled));
  };
  window.setSearchClass = function (classId) {
    const books = booksForClass(classId, { publishedOnly: true });
    const answerBookId = books.some((book) => book.id === appState.answerBookId) ? appState.answerBookId : '';
    appState = Object.assign({}, appState, { classId: classId || null, classNo: classId === 'class-3' ? 3 : null, answerBookId: answerBookId });
    appWriteUrl(true);
    renderSchoolApp();
  };
  window.setSearchBook = function (bookId) {
    appState = Object.assign({}, appState, { answerBookId: bookId || '' });
    appWriteUrl(true);
    updateGenerateAnswerButton(appState.searchQuery || '');
    renderSearchLiveResults();
  };
  window.createBookAnswer = function () {
    const query = String(appState.searchQuery || '').trim();
    if (!appState.classId) return setVoiceSearchStatus('প্রথমে শ্রেণী নির্বাচন করুন।');
    if (!appState.answerBookId) return setVoiceSearchStatus('প্রথমে সেই শ্রেণীর বই নির্বাচন করুন।');
    if (!query) return setVoiceSearchStatus('প্রশ্ন লিখুন বা ভয়েস দিয়ে বলুন।');
    closeAnswerBookPicker();
    if (BUILTIN_IDS.has(appState.answerBookId)) return selectAnswerBook(appState.answerBookId);
    return answerFromAddedBook(appState.answerBookId, query);
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
    appState = Object.assign({}, appState, {
      generatedBookId: book.id,
      generatedQuery: query,
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
    appState = Object.assign({}, appState, error
      ? { aiLoading: false, aiError: error }
      : { aiLoading: false, aiAnswer: answer, aiAnswerKind: 'ai', aiError: '', aiVerificationStatus: 'source-checked' });
    renderGeneratedBookAnswer();
  }
  async function answerFromAddedBook(bookId, query) {
    const book = appBook(bookId);
    if (!book) return setVoiceSearchStatus('বইটি পাওয়া যায়নি।');
    const requestId = beginAnswer(book, query);
    try {
      if (!book.link) throw new Error('এই বইয়ের URL সেটিংসে সেভ করা নেই।');
      setVoiceSearchStatus('সেভ করা লিংক থেকে বই খোলা হচ্ছে… বড় PDF হলে একটু সময় লাগবে।');
      let data = await postJson('/api/read-book', {
        action: 'open',
        url: book.link,
        question: query,
        bookTitle: book.title,
        className: classLabel(appState.classId)
      });
      if (data.fileUri && !data.answer) {
        setVoiceSearchStatus('বইয়ের পাতা পড়ে উত্তর খোঁজা হচ্ছে…');
        data = await postJson('/api/read-book', {
          action: 'answer',
          url: book.link,
          fileUri: data.fileUri,
          mimeType: data.mimeType || 'application/pdf',
          fileName: data.fileName || '',
          question: query,
          bookTitle: book.title,
          className: classLabel(appState.classId)
        });
      }
      if (data.found && data.answer) {
        setVoiceSearchStatus('');
        finishAnswer(requestId, data.answer);
        return;
      }
      const context = solutionContext(bookId);
      if (context) {
        const response = await fetch('/api/generate-answer-v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: query, bookTitle: book.title, context: context, externalFallback: false, answerLanguage: answerLanguageForQuestion(query) })
        });
        const saved = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(saved.error || data.error || 'AI উত্তর তৈরি করা যায়নি।');
        finishAnswer(requestId, String(saved.answer || ''));
        return;
      }
      throw new Error(data.error || 'এই লিংকের বই বা সাইটে প্রশ্নের উত্তর পাওয়া যায়নি। বইয়ের যে পাতায় পাঠ আছে সেই লিংক দিন। লিংকটি সবার জন্য খোলা থাকতে হবে।');
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
    if (bytes.length > 3200000) return end > start ? null : '';
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
    const seen = new Set();
    return items.filter((item) => {
      const key = plain(item.question).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  window.startSolutionJob = async function (resume) {
    if (!adminSession.loggedIn) return alert('আগে লগইন করুন।');
    let job = resume ? readJob() : null;
    if (!job) {
      const classId = document.getElementById('solutionClassSelect')?.value || '';
      const bookId = document.getElementById('solutionBookSelect')?.value || '';
      const book = findBook(bookId) || appBook(bookId);
      if (!classId || !book || !book.link) return alert('লিংকসহ একটি বই নির্বাচন করুন।');
      if (!confirm('সমাধান তৈরী হতে কয়েক মিনিট লাগতে পারে। পেজ বন্ধ করবেন না। কম্পিউটারে করা ভালো। চালু করবেন?')) return;
      job = { bookId: bookId, classId: classId, url: book.link, title: book.title, className: classLabel(classId), kind: '', pageCount: 0, nextPage: 1, items: [], fileUri: '' };
    }
    solutionCancel = false;
    const box = document.getElementById('solutionProgress');
    if (box) box.innerHTML = '<div class="solution-progress">সেভ করা লিংক থেকে বই পড়া হচ্ছে…</div>';
    try {
      const prep = await postJson('/api/read-book', { action: 'prepare', url: job.url, bookTitle: job.title, className: job.className });
      job.kind = prep.kind || 'pdf';
      if (job.kind === 'html') {
        solutionChunks = prep.chunks || [];
        job.pageCount = solutionChunks.length;
      } else {
        solutionChunks = [];
        job.pageCount = Math.min(prep.pageCount || 40, 220);
        job.fileUri = prep.fileUri || job.fileUri || '';
        job.mimeType = prep.mimeType || 'application/pdf';
      }
      if (!job.pageCount) throw new Error('এই লিংক থেকে পড়ার মতো লেখা পাওয়া যায়নি।');
      if (job.nextPage < 1) job.nextPage = 1;
      if (job.nextPage > job.pageCount) job.nextPage = 1;
    } catch (error) {
      if (box) box.innerHTML = `<p class="admin-note error">${esc(error.message)}</p>`;
      return;
    }
    let emptyStreak = 0;
    while (job.nextPage <= job.pageCount) {
      if (solutionCancel) {
        writeJob(job);
        if (box) box.innerHTML = '<p class="admin-note warn">সমাধান তৈরী থামানো হয়েছে। পরে “চালিয়ে যান” চাপতে পারবেন।</p>';
        return;
      }
      if (box) box.innerHTML = progressHtml(job, `${job.title} থেকে প্রশ্ন ও উত্তর তৈরী হচ্ছে…`);
      try {
        let data;
        if (job.kind === 'html') {
          const text = solutionChunks[job.nextPage - 1] || '';
          data = await postJson('/api/read-book', { action: 'solve-text', url: job.url, text: text, bookTitle: job.title, className: job.className, part: job.nextPage });
          job.nextPage += 1;
        } else {
          const end = Math.min(job.pageCount, job.nextPage + 3);
          data = await postJson('/api/read-book', { action: 'solve-pdf', url: job.url, fileUri: job.fileUri || '', mimeType: job.mimeType || 'application/pdf', startPage: job.nextPage, endPage: end, bookTitle: job.title, className: job.className });
          job.nextPage = end + 1;
        }
        const found = (data.items || []).length;
        emptyStreak = found ? 0 : emptyStreak + 1;
        job.items = dedupeItems((job.items || []).concat(data.items || []));
        writeJob(job);
        if (emptyStreak >= 2 && job.nextPage > 16 && job.items.length) break;
        if (emptyStreak >= 3 && job.nextPage > 24 && !job.items.length) break;
      } catch (error) {
        writeJob(job);
        if (box) box.innerHTML = `<p class="admin-note error">${esc(error.message)} এ পর্যন্ত ${bnNum((job.items || []).length)}টি প্রশ্ন রাখা আছে।</p>`;
        return;
      }
    }
    const records = recordsFromItems(job.items || []);
    if (!records.length) {
      writeJob(null);
      if (box) box.innerHTML = '<p class="admin-note error">এই লিংক থেকে কোনো প্রশ্ন পাওয়া যায়নি। লিংকটি সবার জন্য খোলা আছে কিনা দেখুন, অথবা Vercel-এ GEMINI_API_KEY সেট আছে কিনা দেখুন।</p>';
      return;
    }
    catalog.solutions = Object.assign({}, catalog.solutions || {}, { [job.bookId]: records });
    try {
      await saveCatalog();
      writeJob(null);
      if (box) box.innerHTML = `<p class="admin-note">${bnNum(records.length)}টি প্রশ্নসহ সমাধান বই সংরক্ষণ হয়েছে। শ্রেণী পেজের সমাধানে এখন এটি দেখা যাবে।</p>`;
    } catch (error) {
      writeJob(job);
      if (box) box.innerHTML = `<p class="admin-note error">সমাধান তৈরী হয়েছে, কিন্তু সেভ হয়নি: ${esc(error.message)}</p>`;
    }
  };

  renderNav();
  appState = appRouteFromHash();
  appWriteUrl(true);
  renderSchoolApp();
  refreshAdminSession().then(loadCatalog).then(() => {
    renderNav();
    const next = appRouteFromHash();
    if (next.screen !== 'login' && next.screen !== 'settings') appState = Object.assign({}, appState, next);
    renderSchoolApp();
  });
})();
