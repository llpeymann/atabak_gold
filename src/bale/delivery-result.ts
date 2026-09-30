/**
 * Delivery result model.
 *
 * A delivery call must never hide a failure: each platform produces its own result object,
 * so the caller can distinguish «Bale: SUCCESS / Telegram: FAILED» instead of assuming
 * that everything worked.
 */

export type DeliveryPlatform = 'bale' | 'telegram';

export interface DeliveryResult {
  platform: DeliveryPlatform;
  /** Destination channel (never a token). */
  channel: string;
  messageType: 'text';
  /** ISO timestamp of the attempt. */
  timestamp: string;
  durationMs: number;
  success: boolean;
  /** Sanitized failure description; secrets are redacted. Absent on success. */
  error?: string;
}

export interface DeliverySummary {
  succeeded: DeliveryPlatform[];
  failed: DeliveryPlatform[];
  anySucceeded: boolean;
  allFailed: boolean;
}

export function summarizeDelivery(
  results: readonly DeliveryResult[],
): DeliverySummary {
  const succeeded = results.filter((r) => r.success).map((r) => r.platform);
  const failed = results.filter((r) => !r.success).map((r) => r.platform);

  return {
    succeeded,
    failed,
    anySucceeded: succeeded.length > 0,
    // With no targets at all nothing can be considered delivered.
    allFailed: succeeded.length === 0,
  };
}
