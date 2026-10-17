# PHASE STATUS MATRIX — فازهای ۰ تا ۱۲

**کامیت ممیزی‌شده:** `c2508e5` (پایه) + تغییرات فاز ۱۱ روی همان شاخه · **تاریخ:** 2026‑10‑17
**روش:** هر وضعیت فقط از کد واقعی + تست اجراشده یا رفتار مشاهده‌شده می‌آید. «وجود فایل» شاهد نیست.
اعداد ستون تست، تعداد `it()`های فایل‌های spec همان پوشه است و با ۱۳۵۸ تست اجراشده یکی نیست
(تست‌های پارامتری و e2e جدا شمرده می‌شوند)؛ عدد معتبرِ اجرا در جدول پایین آمده است.

| # | فاز | کامیت اصلی | کد | تست‌های واحد | e2e | وضعیت |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Stability & Foundation | `99bc75c` | `Dockerfile`, `docker-compose.yml`, `src/config/*`, `src/bale`, `src/poster`, `src/app.*` | 34 + 9 | `app.e2e-spec` | **PASS** |
| 1 | Market Reliability | `a9e470b` | `src/market/*` (parser/normalizer/sanity/state/engine), `src/price` | 85 + 7 | `market-intelligence.e2e-spec` | **PASS** |
| 2 | Bot UX | `708434e` | `src/bot/ux/*`, `src/platform/*`, `src/users/*` | 212 + 29 + 24 | `bot-ux.e2e-spec` | **PASS** |
| 3 | Price Alerts | `499b229` | `src/alerts/*`, `src/bot/ux/alert-flow*` | 139 | `alert-journey.e2e-spec` | **PASS** |
| 4 | Market Reports (Intelligence) | `4d6ae8d` | `src/intelligence/*`, `src/bot/price-message.builder.ts` | 32 | `market-intelligence.e2e-spec` | **PASS** |
| 5 | Channel Engine | `e02c288` | `src/channel/*` (engine, publisher, store, policy) | 144 | `channel-engine.e2e-spec` | **PASS** |
| 6 | Channel ↔ Bot Integration | `f6e8932` | `src/bot/destination.service.ts`, `src/channel/cta-policy.service.ts`, `src/bot/content/*` | 37 | `channel-engine.e2e-spec` | **PASS** |
| 7 | Referral | `711833a` | `src/referrals/*`, `src/alerts/alert-capacity.service.ts` | 82 | `alert-journey.e2e-spec` | **PASS** |
| 8 | Campaign Tracking & Attribution | `9d046aa` | `src/campaigns/*`, `src/bot/campaign/*` | 60 + 17 | `campaign-tracking.e2e-spec` | **PASS** |
| 9 | Sales Engine | `a1406ae` | `src/sales/*`, `src/bot/sales/*` | 31 + 50 | `sales-engine.e2e-spec` | **PASS** |
| 10 | Admin System | `c2508e5` | `src/admin/*`, `src/bot/admin/*` | 67 + 20 | `admin.e2e-spec` | **PASS** |
| 11 | Monitoring | این کامیت | `src/monitoring/*` + `src/common/persistence-monitor.service.ts` | 86 | `monitoring.e2e-spec` | **PASS** (با ۱ مورد `BLOCKED`) |
| 12 | Final UX Polish | — | **وجود ندارد** | 0 | — | **NOT_RUN** |

## تفکیک وضعیت فاز ۱۱

| معیار | وضعیت |
| --- | --- |
| تشخیص، رخداد ماندگار، شدت، تجمیع | PASS |
| پایش قیمت/کهنگی/بازیابی با شاهد | PASS |
| پایش تحویل و انتشار (تفکیک مقصد) | PASS |
| پایش کارهای زمان‌بندی و «اجرا نشدن» | PASS |
| liveness / readiness / بدون افشای راز | PASS |
| صندوق اعلان مقاوم، ۴۲۹، UNKNOWN، بازیابی یک‌باره | PASS |
| تولیدکننده‌های واقعی (نوشتن ماندگار + مرز خطای UX) | PASS |
| یکپارچگی با مرکز خطای فاز ۱۰ | PASS |
| **مرگ کامل فرآیند (watchdog مستقل)** | **BLOCKED** — مستقر نیست |

## تفکیک وضعیت فاز ۱۲

| مورد | یافته |
| --- | --- |
| کد/ماژول/تست | هیچ فایل یا symbolی با نام Phase 12 / Final UX Polish در مخزن نیست |
| ادعای قبلی | هیچ‌جا (README/docs/کامیت‌ها) ادعای تکمیل فاز ۱۲ نشده است |
| نتیجه | `NOT_RUN` — فاز ۱۲ آغاز نشده است |

## اعداد کل (اجرای واقعی روی همین درخت)

| دروازه | نتیجه |
| --- | --- |
| `npx jest` | **۸۲ سوئیت / ۱۳۷۰ تست PASS** |
| `npx jest --config ./test/jest-e2e.json` | **۹ سوئیت / ۶۶ تست PASS** |
| `npx tsc --noEmit` | **۰ خطا** |
| `eslint {src,test}` | **۰ مشکل** |
| `npm run build` | **PASS** |
| `npm ci` | **PASS** |
| `node dist/demo/main.js --run all` | **۸/۸ PASS** |
| `npm audit --omit=dev` | **۰ آسیب‌پذیری** |
| Docker build | **NOT RUN** (بدون دِیمون) |
| تست زندهٔ بله/تلگرام | **NOT RUN** (بدون اعتبارنامه) |

## جمع‌بندی ماتریس

* ۱۱ فاز از ۱۲ فاز دارای کد و تست اجراشده هستند و همهٔ تست‌ها سبزند.
* فاز ۱۱ یک مورد `BLOCKED` دارد: پوشش مرگ کامل فرآیند با watchdog مستقل (بیرون از repo).
* فاز ۱۲ اصلاً وجود ندارد ⇒ `NOT_RUN` (نه `FAIL`: چیزی برای شکست وجود ندارد).
