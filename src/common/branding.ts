/**
 * Single source of truth for user-facing branding.
 * Canonical brand: «طلای اتابک» — channel handle: @tala_atabak.
 */

export const BRAND_NAME = 'طلای اتابک';
export const CHANNEL_HANDLE = '@tala_atabak';
export const ADMIN_HANDLE = '@atabak_admin';
export const PHONE_NUMBER = '09123510031';
export const MESSAGE_DIVIDER = '━━━━━━━━━━━━━━━━';

/**
 * Shared footer lines used by every published message (price updates and poster reports)
 * so the branding can never diverge between message types again.
 */
export function buildBrandFooterLines(): string[] {
  return [
    MESSAGE_DIVIDER,
    '📎 خرید و فروش طلا و ارز با نرخ روز',
    `👔 ثبت سفارش: ${ADMIN_HANDLE}`,
    `📱 شماره تماس: ${PHONE_NUMBER}`,
    MESSAGE_DIVIDER,
    `🆔 ${CHANNEL_HANDLE}`,
  ];
}
