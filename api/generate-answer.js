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
  const context = String(body.context || '').trim().slice(0, 15000);

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

  const prompt = `তুমি বাংলাদেশের তৃতীয় শ্রেণির একজন সহায়ক শিক্ষক।
নির্বাচিত বই: ${bookTitle}
শিক্ষার্থীর প্রশ্ন: ${question}

নিচে নির্বাচিত বইয়ের প্রাসঙ্গিক পাঠ, প্রশ্ন ও উত্তরের তথ্য দেওয়া হলো:
---
${context}
---

নির্দেশনা:
1. শুধু ওপরের তথ্যকে ভিত্তি করে প্রশ্নটির জন্য নতুন ভাষায় একটি সংক্ষিপ্ত, পরিষ্কার ও বয়স-উপযোগী স্মার্ট উত্তর লেখো।
2. আগের উত্তর হুবহু কপি করবে না; তথ্য ঠিক রেখে সহজ নিজের ভাষায় সাজাবে।
3. তথ্য যথেষ্ট না হলে অনুমান করবে না। সেক্ষেত্রে বলবে: “নির্বাচিত বইয়ের প্রাসঙ্গিক পাঠে এই প্রশ্নের নির্ভরযোগ্য তথ্য পাওয়া যায়নি।”
4. কোনো ভূমিকা, সূত্রের তালিকা বা Markdown শিরোনাম দেবে না; শুধু উত্তর দেবে।`;

  const callGemini = async (model) => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 550 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  try {
    let result = await callGemini(process.env.GEMINI_MODEL || 'gemini-2.5-flash');
    if (!result.response.ok && !process.env.GEMINI_MODEL && result.response.status === 404) {
      result = await callGemini('gemini-2.0-flash');
    }
    if (!result.response.ok) {
      const message = result.data?.error?.message || 'Gemini could not create an answer.';
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
