# PHASE 11 AUDIT — ممیزی مستقل موتور پایش عملیاتی

**دامنه:** درخت کاری پس از فاز ۱۰ (`c2508e5`) + پیاده‌سازی فاز ۱۱.
**روش:** بازخوانی کد واقعی، اجرای واقعی دروازه‌ها، و آزمون رفتار (نه وجود فایل).

---

## ۱. ادعا ↔ شاهد

| ادعا | شاهد در کد | شاهد اجرایی |
| --- | --- | --- |
| رخدادها در همان جدول فاز ۱۰ ذخیره می‌شوند | `MonitoringService.openIncident → AdminErrorService.record` | `test/monitoring.e2e-spec.ts` (مرکز خطا رخداد را نشان می‌دهد) |
| آستانهٔ شکست پیوسته قابل تنظیم است | `thresholdFor` + `MONITORING_PRICE_FAILURE_THRESHOLD` | `monitoring.spec.ts` («honours a threshold other than three») |
| «۲۰۰ با دادهٔ نامعتبر» موفقیت نیست | `BotService.runCycle` فقط با `update.publishable` موفقیت گزارش می‌کند | همان فایل، تست «counts a rejected payload separately» |
| کهنگی از آخرین دادهٔ **معتبر** | `lastValidUpdateIso` → `MarketStateService.getState().lastSuccessfulUpdate` | `monitoring.spec.ts` (stale test) |
| پنجرهٔ شبانه هشدار نمی‌دهد | `evaluateStaleness({scheduledWindowOnly, inActiveWindow})` | `monitoring.rules.spec.ts` («never alarms outside the configured active window») |
| بازیابی فقط با شاهد همان عملیات | `recordSuccess` روی همان category/platform/target | تست «does not resolve an incident because of an unrelated success» |
| نتیجهٔ نامعلوم ارسال نمی‌شود | `status: 'UNKNOWN'` + فیلتر `dueNotifications` | `monitoring-dispatch.spec.ts` («keeps an unanswered send UNKNOWN») |
| ۴۲۹ تلاش را مصرف نمی‌کند | `RATE_LIMIT_SIGNATURE` + `attemptCount` بدون افزایش | تست «honours a rate-limit answer without consuming an attempt» |
| طوفان اعلان مهار می‌شود | `mayNotify` (cooldown + bucket) + dedupeKey یکتا | تست‌های «no notification storm» و «does not send the same notification twice» |
| صندوق از ری‌استارت جان سالم می‌برد | `MonitoringStore` + `test/monitoring.e2e-spec.ts` (بوت دوم) | e2e «keeps incidents, watches and the outbox across a restart» |
| `/health` فاز ۰ تغییر نکرده | `AppController.getHealth` دست‌نخورده | e2e «keeps the Phase 0 `/health` probe working unchanged» |
| readiness به شکست ماندگاری ۵۰۳ می‌دهد | `persistenceCheck` ⇒ `fail` | `monitoring-health.spec.ts` («is unavailable when persistence is actually failing») |
| هیچ secret در سلامت/رخداد نیست | `redactSecrets` + بررسی‌ها بدون chat id | تست‌های «has no secret in any check detail» و «never leaks a bot token» |
| پایش خودش را با رخداد گزارش می‌کند | `onNotificationPipelineFailure` | تست «records the pipeline failure as an incident of its own» |
| شکست واقعی نوشتن، رخداد می‌سازد | `PersistenceMonitor` در هفت فروشگاه + `observePersistence` | `monitoring.wiring.spec.ts` («opens a CRITICAL persistence incident from a real write failure») |
| خطای رسیدگی‌نشدهٔ آپدیت، رخداد می‌سازد | `BotUxService` catch → `onApplicationError` | `monitoring.wiring.spec.ts` («reports an unhandled interaction error…») |
| پایش کار تجاری را برای «تست» اجرا نمی‌کند | `sweep` فقط state می‌خواند | بازبینی کد (بدون فراخوانی `evaluateCycle`/publish) |

## ۲. نقص‌های واقعی که در جریان همین کار پیدا و رفع شدند

| # | نقص | اثر | رفع |
| --- | --- | --- | --- |
| ۱ | تطبیق بازیابی بر اساس *کد دلیل* بود | یک شکست `RETRYABLE` که بعداً `PERMANENT` گزارش می‌شد، هرگز بسته نمی‌شد | تطبیق بر پایهٔ category + platform + target (بدون ادغام مقصدهای متفاوت) |
| ۲ | `redactSecrets` در این نسخه دو آرگومان می‌خواهد | خطای کامپایل در همهٔ فراخوانی‌ها | عبور صریح لیست خالی رازها (پاک‌سازی الگوی توکن هنوز کار می‌کند) |
| ۳ | `MONITORING_ADMIN_CHAT_ID` غیرعددی | اعلان بی‌صدا ارسال نمی‌شد | اعتبارسنجی راه‌اندازی + خطای صریح |
| ۴ | هشدار «مسیر پایش» در دمو | سند پایش می‌توانست بیرون پوشهٔ موقت نوشته شود | `MONITORING_DATA_FILE` در پروفایل دمو + تایمر خاموش |
| ۵ | `.unref()` نبودن تایمر پایش | تایمر می‌توانست فرآیند را زنده نگه دارد | `timer.unref()` + پاک‌سازی در `onModuleDestroy` |
| ۶ | تعداد تست‌های `MonitoringHarness` | `userStore` برای سناریوی fallback لازم بود | افزودن به هارنس (بدون تغییر رفتار تولید) |

## ۳. سوگیری‌های رایج که بررسی شد

* **«همه‌چیز سالم»**: پایش خاموش ⇒ `ok: null` و متن «خاموش»؛ مقصد نداشته باشیم ⇒ warn با دلیل.
* **«ارسال شد»**: `SENT` = پذیرش پلتفرم؛ متن پیام و docs این را تفکیک می‌کنند.
* **«رفع شد»**: فقط با شاهد عملیاتی یا `resolve` صریح اپراتور (که در فاز ۱۰ ثبت می‌شود).
* **آستانه‌های جادویی**: همه در `env.validation.ts` با بازهٔ مجاز؛ `staleAfter` به قاعدهٔ فاز ۱ برمی‌گردد.
* **زیرساخت تازه**: هیچ Redis/صف/دیتابیس اضافه نشد؛ همان الگوی سند JSON.

## ۴. شکاف‌های باقی‌مانده (اعلام صریح)

1. **watchdog مستقل**: مستقر نیست ⇒ مرگ کامل فرآیند پوشش داده نمی‌شود. `BLOCKED` با قرارداد مستند.
2. **اجرای زندهٔ پلتفرم**: `NOT RUN` (بدون اعتبارنامه).
3. **Docker build**: `NOT RUN` (دِیمون در دسترس نیست).
4. **چند مقصد اعلان**: پشتیبانی نمی‌شود (اولین مقصد معتبر). برای دو ادمین، نیاز به تغییر طراحی است.
5. **پنجرهٔ فعال سخت‌کد نشده اما ثابت است** (۰۸:۰۰–۲۲:۱۰)؛ اگر زمان‌بندی عوض شود باید هم‌زمان عوض شود.

## ۵. جمع‌بندی

پیاده‌سازی با §22 (Definition of Done) سازگار است به‌جز مرگ کامل فرآیند (که به استقرار بیرونی نیاز دارد و
صریحاً `BLOCKED` است). دروازه‌های کیفیت روی همین درخت سبزند، هیچ قابلیت فازهای ۱–۱۰ حذف یا تضعیف نشده،
و هیچ سیگنال/رخداد/رسیدی در هیچ‌جا ساخته نشده است.
