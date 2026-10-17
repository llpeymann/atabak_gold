/**
 * Narrow re-exports used by the monitoring domain.
 *
 * The monitoring layer must not depend on admin internals just to name a severity, and it must not
 * invent a second platform vocabulary. These types come from the modules that already own them.
 */

export type { IncidentSeverity } from '../admin/admin.types';
export type { Platform } from '../platform/platform.types';
