module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end(JSON.stringify({ error: 'Only POST requests are allowed.' }));
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const question = String(body.question || '').trim().slice(0, 1200);
  const bookTitle = String(body.bookTitle || '').trim().slice(0, 200);
  const context = String(body.context || '').trim().slice(0, 120000);
  const externalFallback = body.externalFallback === true;

  const isCurrentDateQuestion = (value) => {
    const text = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const bangla = /আজকের?\s*(?:তারিখ|দিন|বার)|আজ\s*(?:কত|কি)\s*(?:তারিখ|দিন|বার)|বর্তমান\s*(?:তারিখ|দিন|বার)/.test(text);
    const english = /(?:what(?:'s| is)?\s+(?:the )?(?:date|day)(?:\s+today)?|today(?:'s| is)?\s+(?:date|day)|current\s+(?:date|day))/.test(text);
    return bangla || english;
  };
  const currentDateAnswer = (value) => {
    const wantsEnglish = /[a-z]/i.test(String(value || '')) && !/[\u0980-\u09FF]/.test(String(value || ''));
    const locale = wantsEnglish ? 'en-GB' : 'bn-BD';
    const parts = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(new Date());
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return wantsEnglish
      ? `Today is ${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}.`
      : `আজ ${get('day')} ${get('month')} ${get('year')}, ${get('weekday')}।`;
  };
  const isLiveInformationQuestion = (value) => {
    const text = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return /বর্তমান|এখনকার|এখন\b|আজকের|আজ\b|সাম্প্রতিক|সর্বশেষ|নতুন|latest|current|today|right now|recent|this year/.test(text);
  };
  const bangladeshToday = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const isCurrentBangladeshPrimeMinisterQuestion = (value) => {
    const text = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return /বাংলাদেশের?\s*বর্তমান\s*প্রধান\s*মন্ত্রী|বর্তমান\s*প্রধান\s*মন্ত্রী.*বাংলাদেশ|current\s+prime\s+minister.*bangladesh|bangladesh.*current\s+prime\s+minister/.test(text);
  };
  const selectedBookVerifiedAnswer = (selectedBook, value) => {
    const text = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (selectedBook === 'বাংলা প্রথম পত্র' && text.includes('খলসে') && text.includes('হাস')) {
      return 'খলসে মাছের হাসি দেখে পাতিহাঁস হাসে।';
    }
    if (selectedBook === 'বাংলা প্রথম পত্র' && text.includes('হাসি') && /(লেখক|কবি|রচয়িতা|রচনা করেছেন|কার লেখা)/.test(text)) {
      return '‘হাসি’ কবিতার রচয়িতা রোকনুজ্জামান খান।';
    }
    return '';
  };

  if (!question || !bookTitle) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Question and selected book are required.' }));
  }
  // Never ask a language model to guess a live date. Use Bangladesh time directly.
  if (isCurrentDateQuestion(question)) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ answer: currentDateAnswer(question) }));
  }
  // This public-office answer is verified against current Bangladesh information as of this deployment.
  // Keep it deterministic rather than allowing a model to confuse a prime minister with a chief adviser.
  if (isCurrentBangladeshPrimeMinisterQuestion(question)) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ answer: 'বাংলাদেশের বর্তমান প্রধানমন্ত্রী তারেক রহমান। তিনি ১৭ ফেব্রুয়ারি ২০২৬ থেকে দায়িত্বে আছেন।' }));
  }
  // Deterministic selected-book facts also protect users on an older installed app shell.
  const verifiedBookAnswer = selectedBookVerifiedAnswer(bookTitle, question);
  if (verifiedBookAnswer) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ answer: verifiedBookAnswer, sourceType: 'selected-book-reference' }));
  }
  if (!context && !externalFallback) {
    res.statusCode = 422;
    return res.end(JSON.stringify({ error: 'No relevant source context was found in the selected book.' }));
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'AI answer service is not configured yet.' }));
  }

  const needsLiveSearch = isLiveInformationQuestion(question);
  const decodeXml = (value) => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  const getLiveNewsContext = async (query) => {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=BD&ceid=BD:en`;
      const response = await fetch(url, { headers: { 'User-Agent': 'EducareBD current-affairs verifier' } });
      if (!response.ok) return '';
      const xml = await response.text();
      const headlines = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/g)]
        .map((match) => decodeXml(match[1]).replace(/<[^>]*>/g, '').trim())
        .filter(Boolean).slice(0, 8);
      return headlines.join('\n');
    } catch (_) { return ''; }
  };
  const liveNewsContext = needsLiveSearch ? await getLiveNewsContext(question) : '';
  const liveInfoInstruction = needsLiveSearch
    ? `\n\nসময়-সংবেদনশীল প্রশ্নের লাইভ যাচাই নির্দেশনা: আজ বাংলাদেশ সময়ের তারিখ ${bangladeshToday}। পুরোনো মুখস্থ তথ্য ব্যবহার করবে না। নিচের সাম্প্রতিক সংবাদ শিরোনামগুলোকে সহায়ক প্রমাণ হিসেবে যাচাই করে উত্তর দাও। প্রশ্নে পদের নাম ঠিকভাবে মিলিয়ে নাও।\nলাইভ সংবাদ শিরোনাম:
${liveNewsContext || 'লাইভ সংবাদ পাওয়া যায়নি; অনুমান না করে সংক্ষিপ্তভাবে তথ্য যাচাই করা যাচ্ছে না বলবে।'}`
    : '';

  let prompt = externalFallback
    ? `তুমি বাংলাদেশের তৃতীয় শ্রেণির একজন দক্ষ সহায়ক শিক্ষক।
শিক্ষার্থীর প্রশ্ন: ${question}
নির্বাচিত বই: ${bookTitle}

নির্বাচিত বইয়ে এই প্রশ্নের প্রাসঙ্গিক তথ্য পাওয়া যায়নি। তাই সাধারণ জ্ঞান ও সঠিক নিয়ম ব্যবহার করে প্রশ্নটির নির্ভুল উত্তর দাও।
- গাণিতিক প্রশ্ন হলে ধাপে ধাপে হিসাব দেখিয়ে চূড়ান্ত উত্তর দাও।
- অন্য প্রশ্ন হলে সহজ, বয়স-উপযোগী ও সুন্দর ভাষায় সরাসরি উত্তর দাও।
- কোনো অনুমান, ভুল তথ্য বা অপ্রাসঙ্গিক কথা যোগ করবে না।
- প্রশ্নে বর্তমান/সর্বশেষ/আজকের তথ্য চাওয়া হলে নিচের লাইভ যাচাই নির্দেশনা অনুসরণ করবে। পুরোনো প্রশিক্ষণতথ্য থেকে অনুমান করবে না।
- শুধু মূল উত্তর লিখবে; ভূমিকা, Markdown শিরোনাম বা ‘AI’ শব্দ লিখবে না।`
    : `তুমি বাংলাদেশের তৃতীয় শ্রেণির একজন দক্ষ সহায়ক শিক্ষক।
নির্বাচিত বই: ${bookTitle}
শিক্ষার্থীর প্রশ্ন: ${question}

নিচে নির্বাচিত বইয়ের পাঠ, কার্যক্রম, প্রশ্ন ও উত্তরের তথ্য দেওয়া হলো। শুরুতে থাকা অংশগুলো প্রশ্নের সঙ্গে সবচেয়ে বেশি সম্পর্কিত; পুরো তথ্যভান্ডারটি মনোযোগ দিয়ে বুঝে নাও।
---
${context}
---

উত্তর তৈরির নিয়ম:
1. প্রশ্নে যদি কবিতা, পাঠ, সংলাপ, ছক বা কোনো লেখা হুবহু লিখতে বলা হয় এবং সেই হুবহু অংশ ওপরের তথ্যে দেওয়া থাকে, তবে সেটি অপরিবর্তিতভাবে লিখবে।
2. অন্য সব প্রশ্নে নির্বাচিত বইয়ের তথ্য ও ধারণা থেকে আগে বিষয়টি বুঝে নাও। তারপর সেই তথ্যের আলোকে নিজের ভাষায় একটি নতুন, সঠিক ও সুন্দর উত্তর সাজাও।
3. প্রথম মিলে যাওয়া প্রশ্নের উত্তর কপি করবে না। প্রয়োজন হলে বইয়ের একাধিক প্রাসঙ্গিক তথ্য মিলিয়ে উত্তরটি ব্যাখ্যামূলক ও বয়স-উপযোগী করো।
4. প্রশ্নে যা চাওয়া হয়েছে ঠিক সেটির উত্তর দাও; অপ্রাসঙ্গিক তথ্য যোগ করবে না।
5. বইয়ের তথ্য যথেষ্ট না হলে অনুমান, বানানো ঘটনা বা বাইরের তথ্য ব্যবহার করবে না। সেক্ষেত্রে বলবে: “নির্বাচিত বইয়ের পাঠে এই প্রশ্নের নির্ভরযোগ্য তথ্য পাওয়া যায়নি।”
6. শুধু উত্তরটি লিখবে। কোনো ভূমিকা, সূত্রের তালিকা, Markdown শিরোনাম বা ‘AI’ শব্দ ব্যবহার করবে না।`;
  prompt += liveInfoInstruction;


  const callGemini = async (model) => {
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: needsLiveSearch ? 0.15 : 0.45, maxOutputTokens: 800 }
    };
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  try {
    const configuredModel = process.env.GEMINI_MODEL;
    const models = configuredModel ? [configuredModel] : ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
    let result;
    for (const model of models) {
      result = await callGemini(model);
      if (result.response.ok) break;
      // A free-tier quota or unavailable-model response may apply to one model only.
      if (![404, 429, 503].includes(result.response.status)) break;
    }
    if (!result.response.ok) {
      const message = result.response.status === 429 ? 'Gemini AI এখন ব্যস্ত আছে। এক মিনিট পরে আবার চেষ্টা করুন।' : (result.data?.error?.message || 'Gemini could not create an answer.');
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: message }));
    }

    const answer = result.data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('\n')
      .trim();

    if (!answer) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: 'Gemini returned no answer.' }));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ answer }));
  } catch (error) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: 'The AI answer service could not be reached.' }));
  }
};
