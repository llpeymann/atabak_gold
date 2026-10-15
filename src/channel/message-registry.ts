import {
  isMessageType,
  MessageKind,
  MessageType,
  MESSAGE_TYPES,
} from './channel.types';

/**
 * Message-type registry (§3.1, §6, §31-A).
 *
 * Every publication has exactly one registered type. The registry is the single place that knows
 * which type is market-derived (Phase 1/4 data) and which one is editorial (human-written, needs
 * approval), plus the official brand title of the type when it belongs to one of the three
 * Atabak Gold content pillars:
 *
 *   EDUCATIONAL      → «گنجینه طلایی اتابک»   (pillar A — education)
 *   BRANDED          → «طلای اتابک»           (pillar B — brand)
 *   NIGHTLY_ANALYSIS → «نگاه طلای اتابک»      (pillar C — nightly market analysis)
 *
 * The four operational market types are deliberately *not* pillars (§6): they are market data,
 * not editorial content, and they must never be presented as brand content.
 */

export interface MessageTypeSpec {
  type: MessageType;
  kind: MessageKind;
  /** Short admin/ops label (logs, management screens). */
  labelFa: string;
  /** Official series title shown inside the message; `null` for operational market messages. */
  seriesTitle: string | null;
  /** Editorial types cannot publish without an explicit approval (§5.5–§5.7, §19). */
  requiresApproval: boolean;
  /** The type is rendered from validated Phase 1/4 data — never from human text. */
  marketDerived: boolean;
  /** Whether the type is scheduled by the engine itself. */
  scheduled: boolean;
  /** Longest body an admin may submit for this type (characters). */
  maxBodyChars: number;
}

/** Titles of the three official content pillars (§6, §20). */
export const PILLAR_TITLES: Record<string, string> = {
  EDUCATIONAL: 'گنجینه طلایی اتابک',
  BRANDED: 'طلای اتابک',
  NIGHTLY_ANALYSIS: 'نگاه طلای اتابک',
};

const REGISTRY: Record<MessageType, MessageTypeSpec> = {
  PRICE_UPDATE: {
    type: 'PRICE_UPDATE',
    kind: 'MARKET',
    labelFa: 'گزارش لحظه‌ای قیمت',
    seriesTitle: null,
    requiresApproval: false,
    marketDerived: true,
    scheduled: true,
    maxBodyChars: 0,
  },
  MARKET_MOVEMENT: {
    type: 'MARKET_MOVEMENT',
    kind: 'MARKET',
    labelFa: 'حرکت مهم بازار',
    seriesTitle: null,
    requiresApproval: false,
    marketDerived: true,
    scheduled: false,
    maxBodyChars: 0,
  },
  DAILY_RANGE: {
    type: 'DAILY_RANGE',
    kind: 'MARKET',
    labelFa: 'بازه روزانه',
    seriesTitle: null,
    requiresApproval: false,
    marketDerived: true,
    scheduled: true,
    maxBodyChars: 0,
  },
  DAILY_REPORT: {
    type: 'DAILY_REPORT',
    kind: 'MARKET',
    labelFa: 'گزارش روزانه بازار',
    seriesTitle: null,
    requiresApproval: false,
    marketDerived: true,
    scheduled: true,
    maxBodyChars: 0,
  },
  EDUCATIONAL: {
    type: 'EDUCATIONAL',
    kind: 'EDITORIAL',
    labelFa: 'آموزشی',
    seriesTitle: PILLAR_TITLES.EDUCATIONAL,
    requiresApproval: true,
    marketDerived: false,
    scheduled: false,
    maxBodyChars: 3_000,
  },
  BRANDED: {
    type: 'BRANDED',
    kind: 'EDITORIAL',
    labelFa: 'برند و معرفی',
    seriesTitle: PILLAR_TITLES.BRANDED,
    requiresApproval: true,
    marketDerived: false,
    scheduled: false,
    maxBodyChars: 3_000,
  },
  NIGHTLY_ANALYSIS: {
    type: 'NIGHTLY_ANALYSIS',
    kind: 'EDITORIAL',
    labelFa: 'تحلیل شبانه',
    seriesTitle: PILLAR_TITLES.NIGHTLY_ANALYSIS,
    requiresApproval: true,
    marketDerived: false,
    scheduled: false,
    maxBodyChars: 3_000,
  },
};

/** Registry lookup — throws for anything that is not one of the seven registered types. */
export function specFor(type: MessageType): MessageTypeSpec {
  return REGISTRY[type];
}

/** Every registered spec, in the canonical order of `MESSAGE_TYPES`. */
export function allSpecs(): readonly MessageTypeSpec[] {
  return MESSAGE_TYPES.map((type) => REGISTRY[type]);
}

/** Editorial (human-written, approval-gated) types — the three content pillars. */
export function editorialSpecs(): readonly MessageTypeSpec[] {
  return allSpecs().filter((spec) => spec.kind === 'EDITORIAL');
}

/** Market-derived types that the engine schedules itself. */
export function scheduledMarketSpecs(): readonly MessageTypeSpec[] {
  return allSpecs().filter((spec) => spec.kind === 'MARKET' && spec.scheduled);
}

/**
 * Validate an untrusted value as a registered message type (§25: message types are validated
 * against the canonical registry, never against a locally invented list).
 */
export function assertMessageType(value: unknown): MessageType {
  if (!isMessageType(value)) {
    throw new Error(
      `Unknown message type: ${String(value)} — only the seven registered types may be published.`,
    );
  }

  return value;
}

export function isEditorialType(type: MessageType): boolean {
  return specFor(type).kind === 'EDITORIAL';
}

/** Official series title of a type, or `null` when it is an operational market message. */
export function seriesTitleOf(type: MessageType): string | null {
  return specFor(type).seriesTitle;
}
