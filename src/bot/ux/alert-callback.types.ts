/**
 * Short, stable keys for the four alert behaviours inside callback payloads.
 *
 * Kept in its own module so `callback-data.ts` (pure, dependency-free parsing) can validate them
 * without knowing the alert domain, and the router can map them to `AlertType` afterwards.
 */
export type AlertTypeKey = 'above' | 'below' | 'up' | 'down';

export const ALERT_TYPE_KEYS: readonly AlertTypeKey[] = [
  'above',
  'below',
  'up',
  'down',
];

export function isAlertTypeKey(value: string): value is AlertTypeKey {
  return (ALERT_TYPE_KEYS as readonly string[]).includes(value);
}
