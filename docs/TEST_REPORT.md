# گزارش تست — Atabak Gold (ممیزی فازهای ۱ تا ۷)

**تاریخ اجرا:** ۲۰۲۶-۱۰-۱۶ · **کامیت:** `711833a` · **محیط:** Linux sandbox، Node `v20.20.2`، npm `10.8.2`
**منبع ماشین‌خوان:** `docs/audit/TEST_RESULTS.json` (از همین اجراها ساخته شده است)
**شرط صداقت:** هر ردیف یا خروجی واقعی دارد، یا صریحاً `NOT RUN / BLOCKED` علامت خورده است.

> این اجراها **بعد از نصب تمیز** (`npm ci`) روی همین درخت تکرار شدند تا نتیجه به وضعیت نصب قبلی وابسته نباشد.

---

## ۱) گیت‌های اصلی

| # | تست | دستور | نتیجهٔ واقعی | وضعیت |
| --- | --- | --- | --- | --- |
| T-01 | نصب وابستگی | `npm ci --no-audit --no-fund` | نصب از lockfile بدون تغییر؛ `npm ls --depth=0` سالم | **PASS** |
| T-02 | کامپایل TypeScript (توسعه) | `npx tsc -p tsconfig.json --noEmit` | ۰ خطا | **PASS** |
| T-03 | کامپایل TypeScript (build) | `npx tsc -p tsconfig.build.json --noEmit` | ۰ خطا | **PASS** |
| T-04 | Lint | `npx eslint "{src,test}/**/*.ts"` | ۰ خطا، ۰ هشدار (exit=0) | **PASS** |
| T-05 | Build | `npm run build` | `dist/main.js` و `dist/demo/*` ساخته شد | **PASS** |
| T-06 | تست‌های واحد/یکپارچگی | `npx jest` | **۶۴ سوئیت / ۱۰۳۹ تست، ۰ شکست، ۰ skip** | **PASS** |
| T-07 | تست E2E | `npm run test:e2e` | **۵ سوئیت / ۳۶ تست، ۰ شکست** | **PASS** |
| T-08 | پوشش | `npm run test:cov` | عملکرد ۹۱٫۴۱٪ / شاخه ۸۱٫۵۵٪ / تابع ۹۲٫۴۹٪ / خط ۹۱٫۴۰٪ | **PASS** |
| T-09 | آسیب‌پذیری وابستگی‌ها | `npm audit --omit=dev` | ۰ آسیب‌پذیری (info/low/moderate/high/critical = 0) | **PASS** |
| T-10 | سازگاری lockfile | `npm ci --dry-run` | بدون اختلاف | **PASS** |

## ۲) توزیع تست‌ها بر پایهٔ فاز

| فاز | سوئیت‌ها | تست‌ها | نمونه‌های کلیدی |
| --- | --- | --- | --- |
| ۰ (زیرساخت) | ۳ | ۱۱ | `config/env.validation.spec.ts`، `common/log-safety.spec.ts`، `test/app.e2e-spec.ts` |
| ۱ (قیمت) | ۱۲ | ۱۲۹ | `market/*.spec.ts`، `market-engine.integration.spec.ts`، `price/*`، `poster/*` |
| ۲ (UX بات) | ۲۰ | ۳۹۰ | `bot/ux/*.spec.ts`، `platform/*.spec.ts`، `test/bot-ux.e2e-spec.ts` |
| ۳ (هشدار) | ۷ | ۱۴۷ | `alerts/*.spec.ts`، `bot/ux/alert-*.spec.ts`، `test/alert-journey.e2e-spec.ts` |
| ۴ (هوش بازار) | ۳ | ۳۵ | `intelligence/*.spec.ts`، `test/market-intelligence.e2e-spec.ts` |
| ۵ (موتور کانال) | ۱۰ | ۱۴۴ | `channel/*.spec.ts`، `test/channel-engine.e2e-spec.ts` |
| ۶ (کانال↔بات) | ۴ | ۵۱ | `bot/deep-link.spec.ts` (۲۴)، `channel/cta-policy.spec.ts` (۱۵)، `bot/ux/deep-link-flow.integration.spec.ts` (۱۶) |
| ۷ (رشد) | ۶ | ۱۱۶ | `referrals/*.spec.ts` (۹۲)، `alerts/alert-capacity.spec.ts` (۱۰)، `users/user.store.spec.ts` (۱۱) |

## ۳) سناریوهای اجرای زنده (روی `dist` واقعی)

| # | سناریو | هدف | دستور | نتیجهٔ واقعی | وضعیت |
| --- | --- | --- | --- | --- | --- |
| D-01 | `overview` | وضعیت فازها/مستندات/تست‌ها | `npm run demo -- --run overview` | ۸ فاز با گزارش و خط وضعیت | **PASS** |
| D-02 | `config` | اعتبارسنجی پیکربندی بدون افشای رمز | `--run config` | `status=ok`، جدول مقادیر مؤثر | **PASS** |
| D-03 | `price-accepted` | گذر دادهٔ معتبر از خط لولهٔ فاز ۱ | `--run price-accepted` | ۱۶ نماد پذیرفته، ۰ رد، پیام واقعی ساخته شد | **PASS** |
| D-04 | `price-rejected` | رد داده‌های خراب + حفظ قیمت معتبر | `--run price-rejected` | `INVALID_SCHEMA`، `INVALID_PRICE`، `MISSING_SYMBOL`، `EXCESSIVE_CHANGE`؛ قیمت قبلی دست‌نخورده | **PASS** |
| D-05 | `bot-conversation` | روتر واقعی بات | `--run bot-conversation` | ۷ پاسخ واقعی؛ ۷ ارسال **ثبت‌شده** (نه ارسال‌شده) | **PASS** |
| D-06 | `alert-lifecycle` | هشدار تا اعلان یک‌باره | `--run alert-lifecycle` | ۰ زیر آستانه، ۱ روی عبور، ۰ تکراری، `SENT` | **PASS** |
| D-07 | `publication` | نتیجهٔ هر مقصد + ضدتکرار | `--run publication` | `bale=SENT`/`telegram=SENT`؛ تکرار → `DUPLICATE_PUBLICATION`؛ خرابی عمدی تلگرام → نتیجهٔ مستقل | **PASS** |
| D-08 | `referral-rewards` | دعوت، پاداش، ظرفیت | `--run referral-rewards` | ۳ دعوت، ۱ پاداش `GRANTED`، ظرفیت ۳→۴، خوددعوتی بی‌اثر | **PASS** |
| D-09 | اجرای همه | تکرارپذیری از حالت تازه | `node dist/demo/main.js --run all` | **۸/۸ PASS** | **PASS** |
| D-10 | پوستهٔ وب | سرو شدن صفحه و API | `curl :3210/` و `/api/run-all` | `http 200` (۸۵۷۳ بایت) و ۸/۸ PASS از طریق HTTP | **PASS** |

## ۴) بررسی راه‌اندازی و پیکربندی (اجرای واقعی روی `dist/main.js`)

| # | تست | ورودی | نتیجهٔ واقعی | وضعیت |
| --- | --- | --- | --- | --- |
| C-01 | نبود کلید الزامی | محیط خالی | `EnvironmentValidationError: Missing required environment variable: PRICE_API_URL` + خروج غیرصفر | **PASS** |
| C-02 | مقدار نامعتبر | `PRICE_API_URL=not-a-url` | `Invalid PRICE_API_URL: "not-a-url" is not a valid absolute URL` | **PASS** |
| C-03 | مسیر سلامت | `/health` | پاسخ `{status:"ok", uptimeSeconds, timestamp}` | **PASS** |
| C-04 | جداسازی دادهٔ دمو | اجرای دمو | همهٔ فایل‌ها در `DEMO_DATA_DIR` (پیش‌فرض `/tmp/atabak-demo`)؛ مخزن دست‌نخورده (`git status` بدون فایل داده) | **PASS** |
| C-05 | عدم ارسال واقعی | اجرای همهٔ سناریوها | هیچ درخواست خروجی به بله/تلگرام؛ همه در حامل شبیه‌سازی ثبت شد | **PASS** |
| C-06 | عدم تماس با منبع قیمت | اجرای دمو | `DemoPriceService` در دمو اجازهٔ تماس نمی‌دهد؛ سناریوها داده را تزریق می‌کنند | **PASS** |
| C-07 | نبود `.env` در گیت | `git log --all --name-only` + `git ls-files` | `.env` هرگز کامیت نشده؛ الگوی توکن در تاریخچه یافت نشد | **PASS** |

## ۵) تست‌های اجرانشده در این محیط (صادقانه)

| # | مورد | دلیل | وضعیت | راه بستن |
| --- | --- | --- | --- | --- |
| N-01 | ساخت ایمیج Docker | Docker در محیط نصب نیست | **NOT RUN** | `docker build -t atabak .` روی میزبان دارای Docker |
| N-02 | تأیید زندهٔ بله با اعتبارنامهٔ واقعی | توکن در دسترس نیست | **BLOCKED** | ست‌کردن `BALE_BOT_TOKEN`/`BALE_CHANNEL_ID` روی کانال آزمایشی و اجرای `npm run start:prod` |
| N-03 | تأیید زندهٔ تلگرام | توکن در دسترس نیست | **BLOCKED** | همان، با `TELEGRAM_BOT_TOKEN` |
| N-04 | دریافت قیمت از سرویس بیرونی | محیط بیرونی ممکن است در دسترس نباشد و برای تست قطعی مطلوب نیست | **NOT RUN** | ست‌کردن `PRICE_API_URL` واقعی روی یک محیط staging |
| N-05 | وارسی دستی انسانی روی UI دمو | فقط خودکار اجرا شد | **NOT RUN** | باز کردن `http://localhost:3210` و اجرای کارت‌ها (بخش ۸ راهنمای دمو) |

> در فازهای ۶ و ۷، اجرای زندهٔ روی Wire واقعی HTTPS (با mock محلی و `/etc/hosts`) انجام و ثبت شده است:
> ۳۹/۳۹ بررسی در فاز ۶ و ۴۱/۴۱ در فاز ۷. آن اجراها روی همان درخت فعلی نیز معتبرند چون کد مسیر انتشار
> تغییری نکرده است؛ با این حال به‌عنوان «شاهد فاز» و نه «شاهد ممیزی» ثبت می‌شوند.

## ۶) تست‌های شکست‌خورده

هیچ. در این دور از اجرا هیچ تستی شکست نخورد، حذف نشد، skip نشد و بی‌اثر (xit/xdescribe) نشد.
اگر در آینده تستی شکست بخورد، دمو (`npm run demo -- --run all`) و همین سند با نتیجهٔ واقعی به‌روز می‌شوند —
نه با پنهان‌کردن شکست.
