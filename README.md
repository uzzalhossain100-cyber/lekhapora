# EducareBD — বাংলা প্রথম পত্র

তৃতীয় শ্রেণির বাংলা প্রথম পত্রের বই, পৃষ্ঠাভিত্তিক অনুশীলনী ও সহায়ক উত্তরসহ একটি সম্পূর্ণ স্ট্যাটিক ওয়েবসাইট।

## GitHub → Vercel-এ প্রকাশের ধাপ

1. GitHub-এ **New repository** চাপুন। নাম দিন `lekhapora`। রিপোজিটরি Public অথবা Private—দুটোই হতে পারে।
2. এই ফোল্ডারের সব ফাইল (`index.html`, `vercel.json`, `.gitignore`) নতুন রিপোজিটরিতে আপলোড করে **Commit changes** দিন।
3. [vercel.com/new](https://vercel.com/new)-এ যান এবং **Continue with GitHub** নির্বাচন করুন।
4. `lekhapora` রিপোজিটরিটি **Import** করুন।
5. Framework Preset হিসেবে **Other** থাকলেই হবে। Build Command এবং Output Directory ফাঁকা রাখুন।
6. **Deploy** চাপুন। কিছুক্ষণ পর Vercel একটি লাইভ URL দেবে, যেমন `https://lekhapora.vercel.app`।

## গুরুত্বপূর্ণ

- নতুন পরিবর্তন GitHub-এ push/commit করলে Vercel নিজে থেকেই সাইটটি নতুন করে প্রকাশ করবে।
- এডমিন লগইন, শ্রেণী/বই যোগ ও AI সমাধান সার্ভার ফাংশন দিয়ে চলে।
- আগে থেকে থাকা স্মার্ট উত্তরের জন্য Vercel-এ `GEMINI_API_KEY` সেট থাকতে হবে।
- এডমিনের যোগ করা শ্রেণী ও বই যাতে সব দর্শক দেখে, Vercel Environment Variables-এ `GITHUB_TOKEN` দিন। টোকেনে এই রিপোর Contents লেখার অনুমতি থাকতে হবে। ঐচ্ছিক: `ADMIN_ID` ও `ADMIN_PASSWORD` দিয়ে লগইন বদলানো যায়।
- বইয়ের Drive লিংক “যে কেউ লিংক দিয়ে দেখতে পারবে” হতে হবে, নাহলে সমাধান তৈরি বই পড়তে পারবে না।
