/**
 * Callback payload contract (the only data a button may carry).
 *
 * Design rules (§39, §40, §41):
 *  - deterministic and versionable: every payload starts with a version tag, so future versions
 *    can be introduced without breaking old buttons,
 *  - short: symbols are validated against the canonical registry, never encoded with details,
 *  - no secrets and no ownership information: a payload can never name a user, so a modified
 *    callback cannot address someone else's data — ownership always comes from the platform
 *    identity resolved server-side.
 */

export const CALLBACK_VERSION = 'v1';

export type ScreenKey =
  'prices' | 'gold' | 'coins' | 'market' | 'favorites' | 'alerts' | 'channel';

export const SCREEN_KEYS: readonly ScreenKey[] = [
  'prices',
  'gold',
  'coins',
  'market',
  'favorites',
  'alerts',
  'channel',
];

export type CallbackAction =
  | { kind: 'menu' }
  | { kind: 'home' }
  | { kind: 'back' }
  | { kind: 'noop' }
  | { kind: 'screen'; screen: ScreenKey }
  | { kind: 'manage-favorites' }
  | { kind: 'favorite'; op: 'add' | 'remove'; symbol: string };

/** Symbols are uppercase registry ids; anything else is rejected before touching the store. */
const SYMBOL_PATTERN = /^[A-Z0-9_]{1,32}$/;

export function callbackDataForMenu(): string {
  return `${CALLBACK_VERSION}:menu`;
}

export function callbackDataForHome(): string {
  return `${CALLBACK_VERSION}:home`;
}

export function callbackDataForBack(): string {
  return `${CALLBACK_VERSION}:back`;
}

export function callbackDataForNoop(): string {
  return `${CALLBACK_VERSION}:noop`;
}

export function callbackDataForScreen(screen: ScreenKey): string {
  return `${CALLBACK_VERSION}:screen:${screen}`;
}

export function callbackDataForManageFavorites(): string {
  return `${CALLBACK_VERSION}:fav:manage`;
}

export function callbackDataForFavorite(
  op: 'add' | 'remove',
  symbol: string,
): string {
  return `${CALLBACK_VERSION}:fav:${op}:${symbol}`;
}

export function isScreenKey(value: string): value is ScreenKey {
  return (SCREEN_KEYS as readonly string[]).includes(value);
}

export function isSafeSymbol(value: string): boolean {
  return SYMBOL_PATTERN.test(value);
}

/**
 * Parse a callback payload. Returns `null` for anything unknown, malformed or from another
 * version — the caller answers with a safe "this option is no longer valid" screen instead of
 * crashing (§40).
 */
export function parseCallbackData(
  data: string | null | undefined,
): CallbackAction | null {
  if (typeof data !== 'string') {
    return null;
  }

  const parts = data.split(':');
  const [version, ...rest] = parts;

  if (version !== CALLBACK_VERSION || rest.length === 0) {
    return null;
  }

  const [head, ...tail] = rest;

  switch (head) {
    case 'menu':
      return tail.length === 0 ? { kind: 'menu' } : null;
    case 'home':
      return tail.length === 0 ? { kind: 'home' } : null;
    case 'back':
      return tail.length === 0 ? { kind: 'back' } : null;
    case 'noop':
      return tail.length === 0 ? { kind: 'noop' } : null;
    case 'screen': {
      const [key, ...extra] = tail;

      return extra.length === 0 && key !== undefined && isScreenKey(key)
        ? { kind: 'screen', screen: key }
        : null;
    }
    case 'fav': {
      const [op, ...extra] = tail;

      if (op === 'manage' && extra.length === 0) {
        return { kind: 'manage-favorites' };
      }

      if (op !== 'add' && op !== 'remove') {
        return null;
      }

      const [symbol, ...symbolExtra] = extra;

      return symbolExtra.length === 0 &&
        symbol !== undefined &&
        isSafeSymbol(symbol)
        ? { kind: 'favorite', op, symbol }
        : null;
    }
    default:
      return null;
  }
}
