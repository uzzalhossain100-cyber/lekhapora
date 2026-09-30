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

- সাইটটি সম্পূর্ণ static; কোনো build command, database বা API key দরকার নেই।
- `index.html` ফাইলে `driveLink` ভ্যারিয়েবলে মূল বইয়ের Google Drive লিংক দেওয়া আছে।
- নতুন কোনো পরিবর্তন GitHub-এ push/commit করলে Vercel নিজে থেকেই সাইটটি নতুন করে প্রকাশ করবে।
