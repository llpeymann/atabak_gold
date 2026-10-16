/**
 * Phase 9 — consent text and retention policy (§6).
 *
 * The consent notice is *shown* by the bot UX and its version is *stored* on every lead
 * (`consentTextVersion`), so a stored lead can always be explained against the exact wording the
 * customer saw. Changing the wording means changing the version — the old text stays documented in
 * git history rather than being silently overwritten.
 */

/** Increment whenever `SALES_CONSENT_NOTICE_FA` changes. */
export const SALES_CONSENT_TEXT_VERSION = 'sales-consent-v1';

/**
 * The notice shown on the confirmation screen, immediately above the submit button, and repeated in
 * the customer confirmation message. Plain Persian, no bundled marketing consent (§6.2).
 */
export const SALES_CONSENT_NOTICE_FA = [
  '🔐 با زدن دکمهٔ «تأیید و ثبت درخواست»:',
  '• نام و شماره تماسی که وارد کردید فقط برای بررسی و پیگیری همین درخواست استعلام استفاده می‌شود.',
  '• اطلاعات تماس شما در اختیار شخص دیگری قرار نمی‌گیرد و برای پیام‌های تبلیغاتی استفاده نمی‌شود.',
  '• برای پیگیری، کارشناسان ممکن است با همین شماره تماس بگیرند.',
  '• اگر بخواهید درخواست حذف/اصلاح شود، با کد پیگیری همین درخواست قابل پیگیری است.',
].join('\n');

/**
 * Retention policy, documented once (§6.5, §18.8).
 *
 * The Sales Engine never deletes an active request or an audit row on its own:
 *
 *  * `SALES_LEAD_RETENTION_DAYS=0` (the default) means *no automatic deletion at all*;
 *  * with a positive value, only leads in a **terminal** status (`CONVERTED`/`LOST`) whose last
 *    update is older than the window may be removed by a future maintenance job — the note is
 *    deliberately documented here rather than hidden in code;
 *  * **no** automatic deletion of the activity history, the sale outcome rows or the notification
 *    state of a lead that still exists: history that can silently disappear is not an audit trail.
 */
export const SALES_RETENTION_POLICY_FA =
  'درخواست‌های فعال و سوابق آن‌ها به‌صورت خودکار حذف نمی‌شوند. در صورت تنظیم SALES_LEAD_RETENTION_DAYS، فقط ' +
  'درخواست‌های پایانی‌یافته (تبدیل‌شده/ازدست‌رفته) و قدیمی‌تر از این بازه قابل پاک‌سازی دوره‌ای هستند؛ ' +
  'تاریخچه و نتیجه فروش فعال حذف نمی‌شود.';
