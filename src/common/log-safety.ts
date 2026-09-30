/**
 * Log-safety helpers: make sure error output is useful but never leaks credentials.
 */

/** Human readable message for an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function truncate(text: string, maxLength = 300): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/**
 * Remove secrets from a log message. Besides exact secret values, bot-token shaped
 * fragments (`bot<id>:<secret>`) are masked because they usually appear inside URLs.
 */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let result = text;

  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      result = result.split(secret).join('***');
    }
  }

  return result.replace(/bot[^\s/]*:[A-Za-z0-9_-]{10,}/g, 'bot***');
}

/**
 * Log-safe URL: keeps protocol/host/path but drops query string, hash and credentials
 * (price APIs frequently carry an API key in the query string).
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
