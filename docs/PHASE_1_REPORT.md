# PHASE 1 — MARKET RELIABILITY — گزارش فنی

**ریپازیتوری:** `github.com/llpeymann/atabak_gold` (برنچ `main`)
**دامنه:** تضمین این‌که هیچ قیمتی بدون عبور از خط لوله‌ی قطعی اعتبارسنجی به Publisher نرسد.
**وضعیت:** COMPLETE — همه‌ی معیارهای Definition of Done پاس شده‌اند (به‌جز `git push` که BLOCKED است؛ بخش ۱۲).

---

## 1. معماری تغییریافته (Architecture Changes)

خط لوله‌ی واحد و قطعی، به‌ترتیب اجرا:

```
Price API ─► PriceService (transport-only: timeout + retry محدود + خروجی خام)
              │
              ▼
        RawPayloadParser ── schema فقط ساختاری (INVALID_SCHEMA)
              │  ParsedRawPayload { entries, sourceTimestamp }
              ▼
        Symbol Registry ── ناشناخته/غایب (UNKNOWN_SYMBOL / MISSING_SYMBOL)
              │
              ▼
        PriceNormalizer ── null/NaN/Infinity/منفی/صفر/رشته نامعتبر
              │  NormalizedPrice { symbol, price, unit, source, receivedAt, sourceTimestamp }
              ▼
        SanityChecker ── بازه منطقی (OUT_OF_RANGE) + تغییر مجاز (EXCESSIVE_CHANGE)
              │  PriceEvaluation { accepted, reason, detail, baseline, ... }
              ▼
        MarketStateService ── commit فقط برای قیمت پذیرفته‌شده (روز تهران)
              │  SymbolMarketState { currentPrice, previousPrice, lastValidPrice, daily, ... }
              ▼
        MarketEngineService ── تصمیم انتشار: publishable = حداقل یک نماد اجباریِ تازه
              │  PublishableMarketUpdate (فقط داده‌ی تأییدشده)
              ▼
   BotService ─► PriceMessageBuilder / PosterService ─► BaleService ─► کانال
                        │
                        └─► AnomalyAlertService ─► چت ادمین (ضد اسپم) / لاگ
```

| جدایی مسئولیت | کلاس | قاعده |
| --- | --- | --- |
| Provider (حمل) | `src/price/price.service.ts` | فقط fetch؛ هرگز تفسیر قیمت نمی‌کند |
| Parser | `src/market/raw-payload.parser.ts` | تنها جایی که شکل خام payload را می‌شناسد |
| Normalizer | `src/market/price-normalizer.service.ts` | تبدیل رشته/واحد به قرارداد داخلی |
| Validator | `src/market/market.types.ts` + `raw-payload.parser` + `sanity-checker` | schema و sanity جدا |
| Sanity/Anomaly | `src/market/sanity-checker.service.ts` | قاعده‌ی قطعی، بدون ML |
| State | `src/market/market-state.service.ts` | فقط قیمت پذیرفته‌شده state را تغییر می‌دهد |
| Persistence | `src/market/market-state.store.ts` | نوشتن اتمیک JSON |
| Publisher | `src/bot/bot.service.ts` | فقط `publishable` منتشر می‌شود |
| Alert | `src/market/anomaly-alert.service.ts` | هشدار ادمین با cooldown |

**قاعده‌ی سخت:** `PublishableMarketUpdate` تنها نوعی است که Builder/Poster می‌پذیرند و اگر چنین نباشد
`throw` می‌کنند؛ فیلد `prices` در حالت مسدود همیشه `[]` است، پس داده‌ی خام یا ردشده هرگز به Publisher نمی‌رسد.

## 2. اعتبارسنجی (Validation)

- **Schema (ساختاری):** نبود `gold`/`currency`، نوع نادرست، یا نبود هیچ ورودی ⇒ `INVALID_SCHEMA` برای کل payload.
- **Symbol:** نبود نماد اجباری ⇒ `MISSING_SYMBOL`؛ نماد ناشناخته در payload ⇒ `UNKNOWN_SYMBOL`.
- **Numeric:** `null`, `undefined`, `NaN`, `Infinity`, منفی، `''`، `'abc'`، `true` ⇒ `INVALID_NUMBER`؛ صفر ⇒ `INVALID_PRICE`.
  رشته‌های عددی (`"17,500,000"`) پذیرفته و نرمال می‌شوند.
- **واحد:** تبدیل متمرکز در `src/common/money.ts` و نرمال‌ساز؛ همه‌ی قیمت‌های ریالی به **ریال** تبدیل می‌شوند؛
  `XAUUSD` روی **USD** می‌ماند (بدون تبدیل ارزی).
- **Sanity (معنایی):** بازه‌ی هر نماد + آستانه‌ی تغییر، جدا از اعتبارسنجی ساختاری.
- **سیاست پاسخ ناقص:** فقط نماد معیوب رد می‌شود؛ بقیه منتشر می‌شوند و وضعیت معتبر قبلی نماد ردشده دست‌نخورده می‌ماند.

هر رد شدن یک `reason` صریح + `detail` انسانی دارد؛ هیچ شکستی خاموش نیست.

## 3. وضعیت بازار (Market State)

مدل هر نماد: `currentPrice`, `previousPrice`, `lastValidPrice`, `updatedAt`, `lastSuccessfulUpdate`, `unit`,
`dayKey` (روز تهرانِ آخرین قیمت معتبر) و `daily`.

- قیمت ردشده **هیچ‌گاه** این فیلدها را تغییر نمی‌دهد (commit فقط برای `accepted`).
- `previousPrice` فقط مبنای مقایسه‌ی *همان روز* است؛ در روز جدید `null` می‌شود.
- `lastValidPrice` بین روزها حفظ می‌شود تا بازیابی سریع باشد.
- **تازه/کهنه:** اگر `receivedAt - lastSuccessfulUpdate > PRICE_STALE_AFTER_MINUTES` ⇒ `STALE` (هرگز FRESH گزارش نمی‌شود).
- نماد کهنه/ردشده نمی‌تواند نماد لنگر انتشار باشد.

## 4. تغییر قیمت (Price Change)

`src/market/price-change.calculator.ts`:

- `percentageChange = ((current - baseline) / baseline) * 100` با **دقت کامل** (هیچ رُندکردنی در محاسبه؛ رُند فقط در نمایش).
- `absoluteChange = current - baseline`.
- جهت: `UP`/`DOWN`/`UNCHANGED`، و `UNKNOWN` وقتی مبنا وجود ندارد.
- مبنا صفر یا منفی معتبر نیست ⇒ `previousPrice = null`, `percentageChange = null`, جهت `UNKNOWN` (بدون تقسیم بر صفر).
- مبنا فقط دو منبع دارد: `SAME_DAY` (قیمت معتبر امروز) یا `PREVIOUS_DAY` (آخرین قیمت معتبر روز قبل، با ضریب
  `PRICE_CROSS_DAY_CHANGE_MULTIPLIER`). برای جلوگیری از مقایسه‌ی گمراه‌کننده، جهت/درصد منتشرشده فقط در حالت
  `SAME_DAY` گزارش می‌شود و در اولین چرخه‌ی روز جدید `UNKNOWN`/`null` است.

## 5. آمار روزانه (Daily Statistics)

- مرز روز: `Asia/Tehran` (از `src/common/tehran-time.ts`، هم‌راستا با زمان‌بندی‌های cron).
- اولین قیمت **پذیرفته‌شده‌ی** روز ⇒ `open` (هرگز close دیروز).
- `high`/`low`/`current` فقط با قیمت پذیرفته‌شده به‌روز می‌شوند؛ `change = current - open`.
- در شروع روز جدید `daily = null` می‌شود و با اولین قیمت پذیرفته‌شده‌ی روز جدید بازساخته می‌شود؛
  مقدار روز قبل به‌عنوان `lastValidPrice` باقی می‌ماند.
- قیمت ردشده/ناهنجار هیچ اثری روی open/high/low/current/change ندارد.

## 6. مدیریت ناهنجاری (Anomaly Handling)

- دو قاعده‌ی قطعی: `OUT_OF_RANGE` (خارج از بازه‌ی نماد) و `EXCESSIVE_CHANGE` (`> maxChangePercent`، همراه با
  گارد اختیاری `maxAbsoluteChange`).
- مبنا در حالت بین‌روزی با ضریب مستندِ `PRICE_CROSS_DAY_CHANGE_MULTIPLIER` (پیش‌فرض ۲) بزرگ‌تر می‌شود.
- هشدار ادمین: `AnomalyAlertService` ⇒ `BaleService.sendMessageTo(ANOMALY_ALERT_CHAT_ID, …)`؛ اگر چت تنظیم نشده
  باشد فقط لاگ خطا (هیچ پیامی به کانال کاربران نمی‌رود).
- **ضد اسپم:** cooldown `ANOMALY_ALERT_COOLDOWN_MINUTES` (پیش‌فرض ۳۰) به‌ازای کلید `symbol:reason`؛ تعداد
  هشدارهای سرکوب‌شده در پیام بعدی گزارش می‌شود. بدون Redis/صف — فقط حافظه‌ی فرایند (نیاز فاز ۱).
- **بازیابی:** اولین قیمت سالم بعد از ناهنجاری، در همان چرخه دوباره قابل انتشار است؛ هیچ retry بی‌پایانی وجود ندارد
  (تلاش‌های API همچنان محدود به `PRICE_API_MAX_ATTEMPTS` است).

## 7. ماندگاری (Persistence)

- `MarketStateStore` وضعیت را در `MARKET_STATE_FILE` (پیش‌فرض `./data/market-state.json`, خالی = بدون ماندگاری)
  ذخیره می‌کند: نوشتن اتمیک (`*.tmp` + `rename`)، نسخه‌دار، بدون تاریخ‌نگاری.
- در startup: فایل نبود/خراب ⇒ شروع از صفر با لاگ صریح (بدون داده‌ی جعلی).
- فقط «آخرین وضعیت معتبر» ذخیره می‌شود (حداقل داده‌ی لازم برای بازیابی پس از ری‌استارت) — نه دیتابیس تاریخی.
- در Docker مسیر `/app/data` ساخته و به کاربر `node` داده شده و به‌صورت `VOLUME` اعلام شده است.

## 8. فایل‌های تغییریافته

**افزوده‌شده (Added)**

| مسیر | نقش |
| --- | --- |
| `src/market/market.types.ts` | قراردادهای دامنه و دلایل رد |
| `src/market/symbols.ts` | رجیستری ۱۶ نماد + آستانه‌ها + دلیل هر آستانه |
| `src/market/raw-payload.parser.ts` | Parser + خطای schema |
| `src/market/price-normalizer.service.ts` | نرمال‌سازی عدد/واحد |
| `src/market/sanity-checker.service.ts` | بازه + تغییر مجاز |
| `src/market/price-change.calculator.ts` | تغییر مطلق/درصدی و جهت |
| `src/market/market-state.service.ts` | وضعیت بازار و آمار روزانه |
| `src/market/market-state.store.ts` | ماندگاری JSON |
| `src/market/anomaly-alert.service.ts` | هشدار ادمین + cooldown |
| `src/market/price-format.ts` | قالب نمایش قیمت/درصد |
| `src/market/market-engine.service.ts` | ارکستراتور خط لوله |
| `src/market/*.spec.ts` (۷ فایل) | تست‌های واحد/یکپارچگی فاز ۱ |
| `docs/PHASE_1_AUDIT.md`, `docs/PHASE_1_REPORT.md` | مستندات فاز |

**تغییر یافته (Modified):** `src/price/price.service.ts` (فقط transport)، `src/bot/bot.service.ts`
(اجرای خط لوله و تصمیم انتشار)، `src/bot/price-message.builder.ts` و `src/poster/poster.service.ts`
(مصرف فقط `PublishableMarketUpdate`)، `src/bale/bale.service.ts` (`sendMessageTo`)،
`src/config/env.validation.ts` + `src/config/app-config.service.ts` (متغیرها و getterها)، `src/app.module.ts`،
`src/testing/test-doubles.ts` (+`createMarketHarness`)، `README.md`، `.env.example`، `.gitignore` (`/data`)،
`Dockerfile`، `docker-compose.yml`، و اسپک‌های موجود قیمت/پیام/پستر/بله/کانفیگ.

**حذف‌شده (Deleted):** `src/price/price.interface.ts` (مدل قیمت قدیمی)، `src/bot/trend-tracker.ts` و
`src/bot/trend-tracker.spec.ts` (با `MarketStateService` جایگزین شد).

## 9. تست‌ها

| گیت | فرمان | نتیجه |
| --- | --- | --- |
| نصب | `npm ci` | ✅ |
| Build | `npm run build` | ✅ |
| Lint | `npm run lint` | ✅ ۰ خطا |
| Unit/Integration | `npm test` | ✅ ۲۰ suite / ۱۷۷ تست |
| E2E | `npm run test:e2e` | ✅ ۲/۲ |
| Docker | `sudo docker build -t atabak-gold .` | ✅ |
| اجرا | `docker run …` | ✅ `/health` = 200، HEALTHCHECK = healthy، کاربر `node`، مسیر `/app/data` قابل نوشتن |

## 10. پوشش تست

`npx jest --coverage` → Statements **91.23%** (937/1027)، Branches **84.21%** (592/703)،
Functions **93.47%** (172/184)، Lines **91.35%** (898/983).

| ماژول | Statements | Branch |
| --- | --- | --- |
| `src/market/*` (کل خط لوله) | 94.71% | 84.96% |
| `price-change.calculator` / `price-format` / `market.types` / `symbols` | 100% | 77–100% |
| `market-engine.service` | 96.52% | 77.17% |
| `market-state.service` | 89.41% | 88.31% |
| `market-state.store` | 80.95% | 62.5% |
| `price-normalizer.service` | 96.22% | 89.18% |
| `bot` / `poster` / `price` / `bale` / `config` / `common` | 92–100% | 65–96% |

سناریوهای پوشش‌داده‌شده: مقدار معتبر، اولین مشاهده بدون مبنا، صفر/منفی/NaN/Infinity/رشته نامعتبر، رشته عددی،
نماد ناشناخته/غایب، payload ناقص، تغییر بیش از حد، خارج از بازه، عبور از مرز روز، کهنگی، بازیابی بعد از ناهنجاری،
cooldown هشدار، ماندگاری/بازیابی پس از ری‌استارت، مسدودشدن انتشار بدون نماد اجباری، عدم انتشار تکراری.

## 11. تغییرات رفتاری (Behavioral Changes)

1. قیمت‌های نامعتبر/ناهنجار دیگر منتشر نمی‌شوند (قبلاً فقط ساختار payload بررسی می‌شد).
2. آمار روزانه و مبنای مقایسه دقیقاً مرز `Asia/Tehran` را دنبال می‌کند و اولین پیام روز جهت `UNKNOWN` دارد.
3. مقایسه‌ی بین‌روزی برای sanity با ضریب ۲ انجام می‌شود، اما درصد/جهت منتشرشده فقط برای همان روز است.
4. `lastValidPrice` بین ری‌استارت‌ها حفظ می‌شود (پیش از این بین‌روزی/فرایندی نبود).
5. آلارم ناهنجاری به چت ادمین می‌رود (تصمیم صریح: هیچ هشدار فنی به کانال کاربران نرود) و ضد اسپم دارد.
6. پیام‌ها فقط از داده‌ی تأییدشده ساخته می‌شوند؛ در حالت مسدود، متن دقیق دلیل در لاگ می‌آید و پیامی منتشر نمی‌شود.
7. نمادهای غایب در پاسخ API حالا با دلیل `MISSING_SYMBOL` گزارش می‌شوند و وضعیت قبلی‌شان حفظ می‌شود.

## 12. مسائل باقی‌مانده (Remaining Issues)

1. **`git push` مسدود است (BLOCKED).** دلیل: محیط اجرا اعتبارنامه‌ی GitHub ندارد:
   `fatal: could not read Username for 'https://github.com': No such device or address`.
   تلاش‌شده: افزودن `origin`، `git push origin main` (exit 128)، بررسی `gh` (نصب نیست).
   لازم: توکن / SSH-key یا انجام push توسط شما؛ خروجی‌ها در `phase1-atabak-gold.patch` و `.bundle` آماده است.
2. `data/market-state.json` فقط «آخرین وضعیت» را نگه می‌دارد (تاریخ‌نگاری عمداً خارج از دامنه‌ی فاز ۱ است).
3. آستانه‌های تغییر برای نوسان‌های واقعی بازار در آینده ممکن است نیاز به تنظیم داشته باشند؛ از طریق
   `PRICE_THRESHOLD_OVERRIDES` بدون تغییر کد قابل تنظیم‌اند.
4. ارسال واقعی به بله در این محیط قابل آزمون نیست (دسترسی شبکه‌ای به `tapi.bale.ai` وجود ندارد)؛
   شکست ارسال در همه‌ی آزم‌ها صادقانه لاگ می‌شود و موفقیت جعلی ثبت نمی‌شود.

## 13. Definition of Done

| # | معیار | وضعیت |
| --- | --- | --- |
| 1 | جدایی کامل provider/parser/normalizer/validator/sanity/state/publisher | PASS |
| 2 | قرارداد داخلی `NormalizedPrice` و ممنوعیت نشت داده خام | PASS |
| 3 | رجیستری واحد نمادها (اجباری/اختیاری) بدون لیست سخت‌کدشده در جای دیگر | PASS |
| 4 | سیاست پاسخ ناقص + حفظ آخرین وضعیت معتبر | PASS |
| 5 | واحد کانونیکال و تبدیل متمرکز | PASS |
| 6 | اعتبارسنجی عددی کامل (null/NaN/Infinity/منفی/صفر/رشته نامعتبر) | PASS |
| 7 | جدایی schema از sanity | PASS |
| 8 | آستانه‌های قابل تنظیم + مستند (جدول نماد/آستانه/دلیل) | PASS |
| 9 | رد ناهنجاری‌ها با دلیل صریح (EXCESSIVE_CHANGE/OUT_OF_RANGE) | PASS |
| 10 | عدم اثر قیمت ردشده بر state و آمار روزانه | PASS |
| 11 | هشدار ادمین + ضد اسپم (بدون Redis/صف) | PASS |
| 12 | `currentPrice`/`previousPrice`/`lastValidPrice`/`updatedAt` | PASS |
| 13 | حفظ وضعیت هنگام خطای API (بدون قیمت جعلی) | PASS |
| 14 | تشخیص STALE/FRESH | PASS |
| 15 | تغییر مطلق/درصدی با دقت کامل، UNKNOWN و null در نبود مبنا | PASS |
| 16 | جهت قطعی UP/DOWN/UNCHANGED/UNKNOWN | PASS |
| 17 | آمار روزانه بر مبنای `Asia/Tehran`، open = اولین قیمت پذیرفته‌شده | PASS |
| 18 | بازیابی پس از ناهنجاری | PASS |
| 19 | ماندگاری حداقلی برای ری‌استارت | PASS |
| 20 | عدم انتشار تکراری / عدم retry بی‌پایان | PASS |
| 21 | ماتریس تست §40 + تست یکپارچگی §41 | PASS (۱۷۷ تست) |
| 22 | حفظ تست‌های فاز ۰ (§42) | PASS |
| 23 | `npm ci` / build / lint / test / test:e2e / docker build | PASS |
| 24 | بدون قابلیت فاز بعدی، بدون AI/ML، بدون جادوی عددی | PASS |
| 25 | `git push` | **BLOCKED** (بدون اعتبارنامه در محیط) |

## 14. آمادگی فاز ۲ (Phase 2 Readiness)

خط لوله‌ی بازار به‌صورت قطعی، مستقل و تست‌شده در جای خود است: ورودی خام هرگز از لایه‌ی provider بیرون نمی‌زند،
Publisher فقط `PublishableMarketUpdate` می‌بیند و هر رد شدن دلیل ماشین‌خوان دارد. آمار روزانه، کهنگی، ماندگاری و
هشدار ادمین آماده‌ی مصرف در فاز ۲ هستند.

تنها مانع باقی‌مانده، `git push` است که به اعتبارنامه‌ی خارج از این محیط نیاز دارد (مسئله‌ی محیطی، نه فنی).
