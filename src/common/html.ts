/**
 * HTML helpers shared by every message producer.
 */

/** Escape a value before inserting it into an HTML-parsed message. */
export function escapeHtml(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Bale renders `<b>` inconsistently, so `<b>`/`</b>` are normalized to `<strong>` before
 * delivery. Telegram accepts both, therefore one normalized text can be sent to both
 * platforms (this preserves the previous per-delivery normalization behaviour).
 */
export function normalizeHtmlForDelivery(text: string): string {
  if (!text) {
    return '';
  }
  return text.replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>');
}
