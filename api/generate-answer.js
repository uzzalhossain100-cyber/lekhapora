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

  if (!question || !bookTitle) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Question and selected book are required.' }));
  }
  if (!context) {
    res.statusCode = 422;
    return res.end(JSON.stringify({ error: 'No relevant source context was found in the selected book.' }));
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'AI answer service is not configured yet.' }));
  }

  const prompt = `তুমি বাংলাদেশের তৃতীয় শ্রেণির একজন দক্ষ সহায়ক শিক্ষক।
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


  const callGemini = async (model) => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.45, maxOutputTokens: 800 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  try {
    const configuredModel = process.env.GEMINI_MODEL;
    const models = configuredModel ? [configuredModel] : ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
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
