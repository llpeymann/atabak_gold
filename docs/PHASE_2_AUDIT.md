# PHASE 2 — BOT UX — ممیزی مخزن و پلن پیاده‌سازی

> این سند پیش از هر تغییری در کد نوشته شده است (Step 1 و Step 2 از دستور فاز ۲).
> مرجع موجود، خودِ مخزن است؛ مرجع رفتار مطلوب، اسپک فاز ۲.

## 1. چه چیزی از قبل وجود دارد (وضعیت واقعی مخزن)

**HEAD:** `daa22b6` روی `main` — شامل فاز ۰ (پایدارسازی) و فاز ۱ (قابلیت اطمینان بازار).

| بخش | وضعیت واقعی |
| --- | --- |
| `src/price/price.service.ts` | فقط transport: timeout + retry محدود، خروجی **payload خام** (`fetchRawPayload()`) |
| `src/market/*` | خط لولهٔ فاز ۱: parser → normalizer → sanity/anomaly → market state → change → publish/reject |
| `src/market/market-state.service.ts` | `getState(def, now)`، `getLastValidPrice()`، `getSameDayPrice()`، `getTrackedSymbolCount()`، `restore()`، `commit()` |
| `src/market/symbols.ts` | رجیستری ۱۶ نماد (gold/coins/currency)، `label`, `order`, `required`, `unit`, `SECTION_TITLES`, `symbolsBySection()`, `SECTION_ORDER` |
| `src/market/price-format.ts` | `formatPriceValue(amount, unit, displayUnit)`، `formatChangePercent()`، `directionEmoji()` |
| `src/common/money.ts` | واحد کانونیکال ریال، تبدیل متمرکز، `formatMoney`, `formatPercentFa`, `formatNumberFa` |
| `src/common/tehran-time.ts` | `tehranDayKey`, `tehranDateFa`, `tehranTimeFa` (`Asia/Tehran`) |
| `src/bale/bale.service.ts` | ارسال **فقط به کانال** (`sendMessage`)، و ارسال به چت صریح برای هشدار ادمین (`sendMessageTo`) |
| `src/bot/bot.service.ts` | فقط cronهای خروجی: قیمت نیم‌ساعتی، قیمت پایانی ۲۲:۰۰، پوستر ۱۲:۱۵/۱۶:۱۵/۱۹:۱۵ |
| `src/common/branding.ts` | `BRAND_NAME`, `CHANNEL_HANDLE='@tala_atabak'`, `ADMIN_HANDLE`, `PHONE_NUMBER`, فوتر مشترک |
| ماندگاری | فاز ۱: `MarketStateStore` → یک فایل JSON با نوشتن اتمیک (`tmp`+`rename`). **هیچ دیتابیسی وجود ندارد.** |
| تست‌ها | ۲۰ suite / ۱۷۷ تست (۲۰ جست فاز ۱ + بقیهٔ فاز ۰/۱)، e2e: ۲ تست (`/`, `/health`) |
| Docker | `Dockerfile` سه‌مرحله‌ای (Node 22)، `/app/data` قابل نوشتن توسط کاربر `node`، HEALTHCHECK فعال |

## 2. چه چیزی وجود ندارد (شکاف‌ها ⇒ کار فاز ۲)

1. **هیچ ورودی (inbound) وجود ندارد.** نه `getUpdates`، نه webhook، نه router، نه callback handler.
   کل تعامل فعلی «خروجی یک‌طرفه به کانال» است. این بزرگ‌ترین شکاف فاز ۲ است.
2. **هیچ مدل کاربری وجود ندارد.** نه User، نه identity، نه session، نه Favorites.
3. **هیچ لایهٔ نمایش (presentation) کاربرمحور وجود ندارد.** متن‌ها فقط برای پیام کانال ساخته می‌شوند.
4. **کلید‌های inline و callback data وجود ندارند.**
5. **هیچ انتزاع پلتفرمی وجود ندارد.** منطق بله/تلگرام مستقیماً داخل `BaleService` است (فقط ارسال).
6. **هیچ هشدار قیمت (Alerts) وجود ندارد** — و طبق اسپک نباید در فاز ۲ پیاده شود (فقط placeholder UI).

## 3. تصمیم‌های معماری (بر پایهٔ واقعیت مخزن)

| تصمیم | دلیل |
| --- | --- |
| **مالتی‌پلکس خواندن از Market State (read-only)** | فاز ۲ فقط با `MarketStateService` و رجیستری نماد حرف می‌زند؛ `PriceService` در مسیر UX اصلاً تزریق نمی‌شود ⇒ بوت هرگز API خارجی صدا نمی‌زند (§3، §12، §50) |
| **انتزاع پلتفرم در `src/platform/`** | یک کلاینت نازک Bot API (شکل Telegram-compatible که بله هم پیاده کرده) + دو adapter؛ منطق UX هیچ شاخهٔ اختصاصی بله/تلگرام ندارد (§10، §47) |
| **Inbound با long-polling (`getUpdates`)** | نه webhook (نیازمند دامنه/گواهی و تغییر زیرساخت)، نه کتابخانهٔ جدید. حلقهٔ polling با offset، backoff و خاموش‌شدنی از env؛ در تست‌ها خاموش است (§43، §60 بدون زیرساخت سنگین) |
| **ماندگاری کاربر/علاقه‌مندی = همان تکنولوژی فاز ۱ (JSON اتمیک)** | «کمترین راهکار قابل‌اعتماد سازگار با معماری موجود»؛ ممنوعیت دیتابیس اضافه (§60). فایل جدا `USER_DATA_FILE` تا از state بازار جدا بماند |
| **یکتایی علاقه‌مندی با قید منطقی + صف‌بندی تغییرات** | `UNIQUE(userId, symbol)` به‌صورت Set + بازنویسی اتمیک فایل + زنجیرهٔ promise برای هر کاربر ⇒ دو درخواست هم‌زمان رکورد تکراری نمی‌سازند (§30، §42) |
| **Edit-in-place با قابلیت پلتفرمی** | adapter پرچم `supportsMessageEditing` و متد `editMessage` دارد؛ اگر ویرایش شکست بخورد fallback به ارسال پیام جدید ⇒ معماری به ویرایش وابسته نیست (§9) |
| **لایهٔ Presentation جدا** | `screens.ts` (ViewModel) → `formatters.ts` (متن فارسی) → `keyboards.ts` (کلید) ⇒ دامنه هرگز متن تلگرام/بله نمی‌سازد (§45، §46) |
| **Session ناوبری در حافظه** | طبق §33 فقط Favorites/User باید پایدار باشند؛ navigation state می‌تواند ریست شود |
| **Event logging ساده** | فقط لاگ ساخت‌یافتهٔ رویداد (بدون داشبورد/فانل) (§48) |

## 4. پلن پیاده‌سازی (ترتیب §66)

1. **User/Persistence:** `src/users/user.types.ts`, `user.store.ts`, `user.service.ts` (identity + favorites + limit + isolation).
2. **Platform:** `src/platform/platform.types.ts`, `bot-api.client.ts`, `platform-adapter.ts`, `platform-registry.service.ts`, `update-poller.service.ts`.
3. **Presentation/Routing:** `src/bot/ux/callback-data.ts`, `screens.ts`, `formatters.ts`, `keyboards.ts`, `ux-event-log.service.ts`, `bot-ux.service.ts`.
4. **Config:** `MAX_FAVORITES`, `CHANNEL_URL`, `USER_DATA_FILE`, `BOT_POLLING_ENABLED`, `BOT_POLL_TIMEOUT_SECONDS`, `BOT_POLL_RETRY_DELAY_MS` در `env.validation.ts` + getterها در `AppConfigService` (بدون جادوی عددی).
5. **Wire-up:** ثبت providerها در `app.module.ts`؛ polling فقط اگر `BOT_POLLING_ENABLED=true`.
6. **تست:** unit (User، callback، formatter، screens، router، poller، client) + integration (جریان Favorites با restart، جریان قیمت بدون تماس با API) + e2e (wiring کامل با adapter جعلی) + رگرسیون فاز ۰/۱.
7. **کیفیت:** `npm ci`, `build`, `lint`, `test`, `test:e2e`, `docker build`.
8. **مستندات:** README + `.env.example` + `docs/PHASE_2_REPORT.md`.

## 5. چیزهایی که عمداً پیاده **نمی‌شوند** (§2، §67)

Alert Engine (فقط placeholder)، فروش/سفارش، CRM، Referral، کمپین، AI/پیش‌بینی، داشبورد ادمین، پورتفوی،
Redis/Kafka/صف/دیتابیس اضافه. در کد و مستندات به‌صورت یادداشت صریح علامت‌گذاری می‌شوند.

## 6. ریسک‌ها و محدودیت‌های محیطی

* `tapi.bale.ai` و `api.telegram.org` از این محیط قابل دسترسی نیستند ⇒ تست انتها‌به‌انتها با adapter قابل‌تعویض انجام
  می‌شود و مسیر خطا (شبکه) هم تست می‌شود؛ هیچ موفقیت جعلی گزارش نمی‌شود.
* polling باید در نبود شبکه، حلقهٔ خطای بی‌پایان پرسروصدا نسازد ⇒ backoff + لاگ محدود (بدون retry بی‌پایان سریع).
