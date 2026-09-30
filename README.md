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
│  Price API (external)│──► PriceService ── timeout + bounded retry + payload validation
└──────────────────────┘         │
                                 ▼
                        ┌─────────────────────┐
                        │  BotService (cron)  │  Asia/Tehran schedules, single publication gate
                        └─────────┬───────────┘
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
   PriceMessageBuilder     PosterService        TrendTracker
   (channel message)      (poster text)      (day-scoped trend baseline)
             └────────────────────┼────────────────────┘
                                  ▼
                           BaleService ──► Bale API  (required)
                                     └──► Telegram API (optional)
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
| `src/bot/trend-tracker.ts` | وضعیت روند قیمت، ریست‌شده در هر روز تهران |
| `src/poster/poster.service.ts` | ساخت متن گزارش پوستر |
| `src/bale/bale.service.ts` | ارسال به بله/تلگرام و بازگرداندن نتیجه دقیق هر پلتفرم |
| `src/common/` | ابزارهای مشترک: واحد پول (ریال/تومان)، برندینگ، زمان تهران، ایمنی لاگ، HTML |

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
* روند قیمت: پایه مقایسه فقط با آخرین قیمتِ منتشرشده در همان روز تهران به‌روز می‌شود و در شروع روز جدید ریست
  می‌گردد؛ بنابراین اولین پیام روز با قیمت دیروز مقایسه نمی‌شود.

## 12. Deployment notes

* حداقل متغیرهای لازم برای استقرار: `PRICE_API_URL`، `BALE_BOT_TOKEN`، `BALE_CHANNEL_ID`
  (برای آینه‌کردن به تلگرام: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANNEL_ID`).
* کانتینر روی پورت `3000` گوش می‌دهد و به `0.0.0.0` بایند می‌شود؛ برای پلتفرم‌های PaaS کافی است `PORT` را ست کنند.
* `/health` را به health check پلتفرم وصل کنید (پاسخ ۲۰۰ = سالم).
* اسرار را فقط از راه متغیرهای محیطی/secret manager تزریق کنید؛ هرگز در ایمیج یا ریپو قرار ندهید.
