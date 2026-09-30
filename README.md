# طلای اتابک — ربات گزارش بازار (Atabak Gold market bot)

سرویس زمان‌بندی‌شده‌ای بر پایه **NestJS 11** که قیمت‌های بازار طلا، سکه و ارز را از یک API بیرونی می‌گیرد و
به‌صورت پیام متنی منظم در کانال **بله** (و در صورت تنظیم، **تلگرام**) منتشر می‌کند.

A scheduled NestJS service that publishes gold, coin and currency market prices to a **Bale**
channel (and optionally a mirrored **Telegram** channel).

---

## 1. Overview / نمای کلی

* منبع قیمت: یک API بیرونی JSON که با `PRICE_API_URL` معرفی می‌شود.
* کانال‌های انتشار: **بله** (اجباری) و **تلگرام** (اختیاری).
* زمان‌بندی: ساعت ۰۸:۰۰ تا ۲۱:۳۰ هر نیم‌ساعت + پیام پایانی ۲۲:۰۰ + گزارش پوستر سه‌بار در روز — همه به وقت تهران.
* بدون دیتابیس، Redis یا صف: وضعیت فقط شامل آخرین قیمت‌های منتشرشده در حافظه است (برای محاسبه روند روزانه).
* فقط یک endpoint عمومی برای پایش سلامت: `GET /health`.

## 2. Architecture

```
┌──────────────────────┐
│  Price API (external)│──► PriceService ── transport only: timeout + bounded retry + raw payload
└──────────────────────┘         │  (raw JSON, never leaves this layer)
                                 ▼
                        ┌────────────────────────────────────────────┐
                        │  MarketEngineService (single entry point)   │
                        │  Parser → Normalizer → Schema/Symbol/Number │
                        │  → Sanity/Anomaly → Market State → Change   │
                        │  → Daily stats → Publish / Reject(+reason)  │
                        └─────────┬───────────────────────────────────┘
                                  ▼  PublishableMarketUpdate (only approved domain objects)
                        ┌─────────────────────┐
                        │  BotService (cron)  │  Asia/Tehran schedules, single publication gate
                        └─────────┬───────────┘
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
   PriceMessageBuilder     PosterService      MarketStateStore
   (channel message)      (poster text)     (JSON persistence, restart-safe)
             └────────────────────┼────────────────────┘
                                  ▼
                           BaleService ──► Bale API  (required)
                                     ├──► Telegram API (optional)
                                     └──► admin anomaly alerts (explicit chat id)
```

| مسیر | نقش |
| --- | --- |
| `src/main.ts` | راه‌اندازی اپ، لاگ پورت و مدیریت خطای startup |
| `src/app.controller.ts` / `app.service.ts` | مسیرهای `/` و `/health` |
| `src/config/env.validation.ts` | اعتبارسنجی متغیرهای محیطی در زمان startup |
| `src/config/app-config.service.ts` | نمای تایپ‌دار و امن از محیط |
| `src/price/` | کلاینت API قیمت (timeout، retry، اعتبارسنجی داده) |
| `src/bot/bot.service.ts` | زمان‌بندی‌ها و هماهنگی انتشار |
| `src/bot/price-message.builder.ts` | ساخت متن پیام کانال |
| `src/market/` | خط لوله بازار (فاز ۱): رجیستری نمادها، parser، normalizer، sanity/anomaly، تغییر قیمت، وضعیت بازار و موتور تصمیم |
| `src/market/market-state.store.ts` | ماندگاری JSON وضعیت بازار (نوشتن اتمیک، مقاوم در برابر فایل خراب) |
| `src/market/anomaly-alert.service.ts` | هشدار ناهنجاری به چت ادمین با cooldown (ضد اسپم) |
| `src/poster/poster.service.ts` | ساخت متن گزارش پوستر |
| `src/bale/bale.service.ts` | ارسال به بله/تلگرام و بازگرداندن نتیجه دقیق هر پلتفرم |
| `src/bot/ux/` | لایه تجربه کاربری (فاز ۲): روتر دکمه‌ها، گرامر callback، view model بازار، قالب‌بندی فارسی، کیبوردها، لاگ رویداد |
| `src/users/` | کاربران و علاقه‌مندی‌ها: مدل مینیمال، store اتمیک JSON، سرویس با اعتبارسنجی نماد و سقف علاقه‌مندی |
| `src/platform/` | لایه انتزاعی پلتفرم: کلاینت Bot API، آداپتر بله/تلگرام، registry و long-poll ورودی |
| `src/common/` | ابزارهای مشترک: واحد پول (ریال/تومان)، برندینگ، زمان تهران، ایمنی لاگ، HTML |

**مسیر داده در فاز ۲:** آپدیت کاربر → `UpdatePollerService` (long-poll) → آداپتر پلتفرم →
`BotUxService` (روتر + callback grammar) → `MarketViewService` (فقط خواندن از وضعیت فاز ۱) →
`ux-format` (متن فارسی) → آداپتر پلتفرم (ویرایش پیام؛ در صورت پشتیبانی‌نشدن، ارسال پیام تازه).
هیچ مسیری از لایه UX به API قیمت وجود ندارد و همین موضوع در تست‌ها اثبات شده است.

**واحد پول داخلی:** همه قیمت‌ها در واحد **ریال** نگه‌داری و با نام `priceInRial` منتقل می‌شوند. تبدیل واحد
فقط از طریق `src/common/money.ts` انجام می‌شود و هر عدد نمایش‌داده‌شده واحد خود را همراه دارد
(هیچ ابهامی بین ریال و تومان باقی نمی‌ماند).

## 3. Requirements

* Node.js **>= 20** (توسعه و ایمیج با Node 22 آزمایش شده است)
* npm
* Docker (اختیاری، برای اجرای کانتینری)

## 4. Installation

```bash
git clone https://github.com/llpeymann/atabak_gold.git
cd atabak_gold
npm ci                 # نصب دقیق و بازتولیدپذیر بر اساس package-lock.json
cp .env.example .env   # سپس مقادیر واقعی را در .env بگذارید
```

## 4.1 خط لوله اعتبارسنجی قیمت (Phase 1)

هیچ قیمتی مستقیماً از API به کانال نمی‌رسد. هر چرخه از این مراحل قطعی می‌گذرد و هر رد شدن، دلیل صریح دارد:

| مرحله | مسئول | رد می‌کند وقتی |
| --- | --- | --- |
| Parse | `raw-payload.parser.ts` | بدنه JSON ساختار انتظاری را ندارد (`INVALID_SCHEMA`) |
| Symbol | `symbols.ts` (رجیستری واحد، ۱۶ نماد) | نماد در payload نیست (`MISSING_SYMBOL`) یا ناشناخته است (`UNKNOWN_SYMBOL`) |
| Normalize | `price-normalizer.service.ts` | مقدار null/NaN/Infinity/غیرعددی/منفی/صفر باشد (`INVALID_NUMBER`, `INVALID_PRICE`)؛ رشته‌های عددی و واحدها به قرارداد داخلی تبدیل می‌شوند |
| Sanity | `sanity-checker.service.ts` | خارج از بازه منطقی نماد (`OUT_OF_RANGE`) یا تغییر بیش از آستانه (`EXCESSIVE_CHANGE`) |
| State | `market-state.service.ts` | قیمت ردشده هرگز `currentPrice`/`lastValidPrice`/ساعات روزانه را تغییر نمی‌دهد |
| Publish | `market-engine.service.ts` | هیچ نماد اجباری تازه‌ای نباشد (`NO_FRESH_REQUIRED_SYMBOL` / `NO_ACCEPTED_PRICES`) |

* نمادهای اجباری (لنگر انتشار): `IR_GOLD_18K`، `IR_COIN_EMAMI`، `USD`. پاسخ ناقص فقط همان نماد را رد
  می‌کند، نه کل چرخه را؛ وضعیت معتبر قبلی آن نماد دست‌نخورده می‌ماند.
* آستانه‌ها برای هر نماد مستند و قابل بازنویسی‌اند (بازه منطقی، سقف درصد تغییر، سقف تغییر مطلق).
  نمادهای نقدی/ارز سقف تغییر کمتری دارند؛ دارایی‌های پرنوسان سقف بیشتری.
* روز معاملاتی بر مبنای `Asia/Tehran` تعریف می‌شود؛ اولین قیمت پذیرفته‌شده‌ی هر روز «open» آن روز است و
  هرگز با قیمت دیروز مقایسه نمی‌شود. مبنای مقایسه فقط `previousPrice` همان روز است؛ اگر وجود نداشته
  باشد جهت `UNKNOWN` و درصد تغییر `null` است (بدون رُندکردن زودرس، با دقت کامل).
* ناهنجاری‌ها به چت ادمین (`ANOMALY_ALERT_CHAT_ID`) اطلاع داده می‌شوند — نه به کانال کاربران — با
  `ANOMALY_ALERT_COOLDOWN_MINUTES` برای جلوگیری از اسپم (بدون Redis/صف).

## 4.2 لایه تجربه کاربری ربات (Phase 2)

ربات علاوه بر انتشار زمان‌بندی‌شده در کانال، یک بات تعاملی است. مسیر کاربر:

`/start` → منوی اصلی → 💰 قیمت لحظه‌ای | 🟡 طلا | 🪙 سکه | 📊 بازار | 🔔 هشدار (به‌زودی) |
⭐ علاقه‌مندی‌ها | 📢 کانال اتابک

* **تک‌منبع حقیقت قیمت:** همه صفحه‌ها فقط از «وضعیت بازار» فاز ۱ خوانده می‌شوند. لایه UX هیچ‌وقت
  مستقیم به API قیمت وصل نمی‌شود و هیچ قیمتی را بازمحاسبه یا جعل نمی‌کند؛ دکمه «↻ بروزرسانی» فقط
  وضعیت موجود را دوباره می‌خواند. نماد بدون داده به‌صورت «بدون اطلاعات معتبر» فهرست می‌شود.
* **قیمت کهنه:** اگر آخرین قیمت معتبر قدیمی‌تر از `PRICE_STALE_AFTER_MINUTES` باشد، هشدار
  «⚠️ آخرین قیمت معتبر …» نمایش داده می‌شود و هیچ‌وقت به‌شکل داده تازه نشان داده نمی‌شود.
* **علاقه‌مندی‌ها:** افزودن/حذف فقط از روی نمادهای ثبت‌شده (بدون تایپ دستی نماد)، بدون تکرار،
  سقف `MAX_FAVORITES`، و ذخیره‌شده در `USER_DATA_FILE` پس از ری‌استارت.
* **هشدار (Alerts):** در این فاز فقط یک صفحه با متن «این قابلیت به‌زودی فعال می‌شود.» است؛ هیچ
  زمان‌بند/آستانه/ارسال نوتیفیکیشن وجود ندارد (فاز ۳).
* **دکمه‌های قدیمی:** هر callback ناشناخته یا منقضی به پیام «این گزینه دیگر معتبر نیست.» + دکمه
  «🏠 منوی اصلی» پاسخ می‌دهد و هرگز باعث خطا نمی‌شود. خطاهای فنی فقط در لاگ سرور ثبت می‌شوند.
* **لاگ رویداد:** رویدادهای پایه (`start`, `menu_open`, `prices_view`, `gold_view`, `coin_view`,
  `market_view`, `favorites_view`, `favorite_added`, `favorite_removed`, `channel_clicked`,
  `alerts_clicked`) با شناسه کاربر و بدون هیچ داده شخصی در لاگ ثبت می‌شوند.

## 5. Environment variables

| متغیر | اجباری | پیش‌فرض | توضیح |
| --- | --- | --- | --- |
| `PRICE_API_URL` | ✅ | — | آدرس کامل http(s) برای دریافت قیمت‌ها |
| `BALE_BOT_TOKEN` | ✅ | — | توکن ربات بله |
| `BALE_CHANNEL_ID` | ✅ | — | شناسه کانال بله |
| `TELEGRAM_BOT_TOKEN` | ❌ | — | توکن ربات تلگرام (ارسال تلگرام فقط با بودن هر دو مقدار فعال می‌شود) |
| `TELEGRAM_CHANNEL_ID` | ❌ | — | شناسه کانال تلگرام |
| `PORT` | ❌ | `3000` | پورت HTTP |
| `PRICE_API_TIMEOUT_MS` | ❌ | `20000` | تایم‌اوت هر درخواست به API قیمت |
| `PRICE_API_MAX_ATTEMPTS` | ❌ | `3` | حداکثر تلاش برای هر دریافت (۱ = بدون retry) |
| `PRICE_API_RETRY_DELAY_MS` | ❌ | `1500` | تأخیر پایه بین تلاش‌ها (backoff نمایی) |
| `DELIVERY_TIMEOUT_MS` | ❌ | `20000` | تایم‌اوت هر ارسال پیام |
| `PRICE_API_UNIT` | ❌ | `RIAL` | واحد مقادیر برگشتی API (`RIAL` یا `TOMAN`) |
| `PRICE_DISPLAY_UNIT` | ❌ | `RIAL` | واحد نمایش در پیام‌ها (`RIAL` یا `TOMAN`) |
| `PRICE_SYMBOL_UNITS` | ❌ | خالی | بازنویسی واحد برای نمادهای خاص؛ مثال: `USDT_IRT=TOMAN,USD=TOMAN` |
| `PRICE_MAX_CHANGE_PERCENT` | ❌ | `8` | سقف مجاز تغییر قیمت (درصد) برای نمادهایی که آستانه اختصاصی ندارند |
| `PRICE_THRESHOLD_OVERRIDES` | ❌ | خالی | بازنویسی آستانه تغییر هر نماد؛ مثال: `IR_GOLD_18K=12,IR_COIN_EMAMI=15` |
| `PRICE_CROSS_DAY_CHANGE_MULTIPLIER` | ❌ | `2` | ضریب آستانه وقتی مبنای مقایسه، قیمت معتبر روز تهران قبل است |
| `PRICE_STALE_AFTER_MINUTES` | ❌ | `45` | سنّی که بعد از آن قیمت «کهنه/STALE» علامت می‌خورد |
| `MARKET_STATE_FILE` | ❌ | `./data/market-state.json` | فایل ماندگاری وضعیت بازار (خالی = بدون ماندگاری) |
| `ANOMALY_ALERT_CHAT_ID` | ❌ | خالی | چت ادمین برای هشدار ناهنجاری (خالی = فقط لاگ) |
| `ANOMALY_ALERT_COOLDOWN_MINUTES` | ❌ | `30` | حداقل فاصله بین دو هشدار یکسان (نماد + دلیل) |
| `USER_DATA_FILE` | ❌ | `./data/users.json` | فایل ماندگاری کاربران و علاقه‌مندی‌ها (خالی = بدون ماندگاری) |
| `MAX_FAVORITES` | ❌ | `10` | حداکثر تعداد علاقه‌مندی هر کاربر (۱ تا ۱۰۰) |
| `CHANNEL_HANDLE` | ❌ | `@tala_atabak` | هندل کانال که در متن‌ها نمایش داده می‌شود |
| `CHANNEL_URL` | ❌ | `https://ble.ir/tala_atabak` | لینک دکمه «📢 کانال اتابک» |
| `BOT_POLLING_ENABLED` | ❌ | `true` | دریافت آپدیت‌های کاربران (خاموش = فقط انتشار زمان‌بندی‌شده) |
| `BOT_POLL_TIMEOUT_SECONDS` | ❌ | `25` | مدت انتظار long-poll در پلتفرم |
| `BOT_POLL_RETRY_DELAY_MS` | ❌ | `3000` | تأخیر تلاش مجدد پس از خطای دریافت آپدیت |

نمونه کامل در فایل [`.env.example`](./.env.example) موجود است. فایل `.env` در `.gitignore` است و
هیچ توکنی نباید کامیت شود (متغیرهای محیطی در زمان startup اعتبارسنجی می‌شوند و در صورت نبود مقدار
اجباری، برنامه با پیام روشن مثل `Missing required environment variable: PRICE_API_URL` بالا نمی‌آید).

## 6. Local development

```bash
npm ci
npm run start:dev      # اجرا با watch
npm run start          # اجرای معمول
npm run start:prod     # اجرای خروجی build شده (node dist/main)
```

## 7. Quality gates

```bash
npm run build          # کامپایل TypeScript با تنظیمات strict
npm run lint           # ESLint (بدون تغییر فایل) — باید ۰ خطا بدهد
npm run lint:fix       # اصلاح خودکار
npm test               # تست‌های واحد (jest)
npm run test:e2e       # تست end-to-end (supertest)
npm run test:cov       # پوشش تست
npm run format         # فرمت‌دهی Prettier
```

## 8. Docker

```bash
docker build -t atabak-gold .
docker run --rm -p 3000:3000 --env-file .env atabak-gold
# یا
docker compose up -d --build
```

نکات ایمیج:

* ایمیج چندمرحله‌ای روی `node:22-bookworm-slim`؛ **بدون Python** و بدون نصب پکیج سیستمی.
* فقط `dist/`، وابستگی‌های production و `package.json` وارد ایمیج نهایی می‌شوند.
* اجرا با کاربر غیرروت `node` و دارای `HEALTHCHECK` روی `/health`.

## 9. Health endpoint

```http
GET /health
```

```json
{ "status": "ok", "uptimeSeconds": 42, "timestamp": "2026-09-30T10:20:36.669Z" }
```

پاسخ `200` یعنی خودِ اپلیکیشن سالم است؛ این endpoint عمداً به API قیمت وابسته نیست تا قطعی سرویس بیرونی
وضعیت اپ را unhealthy نشان ندهد.

## 10. Cron schedules (Timezone: `Asia/Tehran`)

| Job | زمان‌بندی | Cron expression | انتشار |
| --- | --- | --- | --- |
| به‌روزرسانی قیمت (نیم‌ساعتی) | ۰۸:۰۰ تا ۲۱:۳۰، هر ۳۰ دقیقه | `0 0,30 8-21 * * *` | پیام قیمت کانال |
| به‌روزرسانی پایانی روز | ۲۲:۰۰ | `0 0 22 * * *` | پیام قیمت کانال |
| گزارش پوستر | ۱۲:۱۵، ۱۶:۱۵، ۱۹:۱۵ | `15 12,16,19 * * *` | متن پوستر |

* همه زمان‌ها صریحاً با `timeZone: 'Asia/Tehran'` اجرا می‌شوند تا مستقل از TZ سرور باشند.
* ساعت گزارش پوستر از ۱۲:۰۰/۱۶:۰۰/۱۹:۰۰ به ۱۲:۱۵/۱۶:۱۵/۱۹:۱۵ منتقل شده است، چون در زمان قبلی دقیقاً
  هم‌زمان با به‌روزرسانی نیم‌ساعتی اجرا می‌شد و دو پیام را در یک دقیقه منتشر می‌کرد.
* علاوه بر این، یک «قفل انتشار» تضمین می‌کند تا وقتی یک انتشار در جریان است، اجرای هم‌زمان دیگری پیام
  تکراری نفرستد.

## 11. Failure behaviour

* خطای API قیمت: بدون انتشار هیچ پیامی، بدون قیمت جعلی؛ خطا با context در لاگ ثبت می‌شود.
  تنها خطاهای گذرا (شبکه، تایم‌اوت، HTTP 5xx، HTTP 429) با backoff نمایی دوباره تلاش می‌شوند.
* خطای ارسال: برای هر پلتفرم نتیجه جدا (`success: false` + متن خطای پاک‌سازی‌شده) برگردانده می‌شود؛
  لاگ هرگز موفقیت کاذب ثبت نمی‌کند و توکن‌ها در لاگ‌ها ماسک می‌شوند.
* روند قیمت: پایه مقایسه فقط با آخرین قیمتِ معتبر در همان روز تهران به‌روز می‌شود و در شروع روز جدید بازنشانی
  می‌گردد؛ بنابراین اولین پیام روز با قیمت دیروز مقایسه نمی‌شود.
* داده نامعتبر یا ناهنجار: قیمت رد می‌شود، دلیل آن (`OUT_OF_RANGE`, `EXCESSIVE_CHANGE`, ...) در لاگ و در
  هشدار ادمین ثبت می‌شود و وضعیت معتبر قبلی نماد در حافظه/فایل باقی می‌ماند؛ هیچ آمار روزانه‌ای آلوده نمی‌شود.
* قیمت کهنه (`STALE` بعد از `PRICE_STALE_AFTER_MINUTES`): به‌عنوان «تازه» منتشر نمی‌شود و نماد لنگر
  انتشار محسوب نمی‌شود؛ اما به‌عنوان «آخرین قیمت معتبر» در دسترس است.
* بازیابی: به‌محض رسیدن یک قیمت سالم بعد از یک ناهنجاری، همان چرخه مجدداً قابل انتشار می‌شود (بدون
  retry بی‌پایان و بدون شمارنده‌ی فرسایشی).

## 12. Deployment notes

* حداقل متغیرهای لازم برای استقرار: `PRICE_API_URL`، `BALE_BOT_TOKEN`، `BALE_CHANNEL_ID`
  (برای آینه‌کردن به تلگرام: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANNEL_ID`).
* کانتینر روی پورت `3000` گوش می‌دهد و به `0.0.0.0` بایند می‌شود؛ برای پلتفرم‌های PaaS کافی است `PORT` را ست کنند.
* `/health` را به health check پلتفرم وصل کنید (پاسخ ۲۰۰ = سالم).
* اسرار را فقط از راه متغیرهای محیطی/secret manager تزریق کنید؛ هرگز در ایمیج یا ریپو قرار ندهید.
* وضعیت بازار در `MARKET_STATE_FILE` (پیش‌فرض `./data/market-state.json`) و داده کاربران/علاقه‌مندی‌ها
  در `USER_DATA_FILE` (پیش‌فرض `./data/users.json`) ذخیره می‌شود. برای حفظ آن بین
  ری‌استارت‌ها یک volume به مسیر داده وصل کنید:
  `docker run -v atabak-data:/app/data ...` یا در compose: `volumes: ["atabak-data:/app/data"]`.
  اگر فایل خالی/خراب باشد برنامه بالا می‌آید و وضعیت را از صفر می‌سازد (بدون داده جعلی).
* اگر `ANOMALY_ALERT_CHAT_ID` خالی باشد، هشدارهای ناهنجاری فقط در لاگ ثبت می‌شوند و هیچ پیامی به کانال
  کاربران نمی‌رود.
