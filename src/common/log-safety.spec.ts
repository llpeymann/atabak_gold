import {
  describeError,
  redactSecrets,
  sanitizeUrl,
  truncate,
} from './log-safety';

describe('log-safety helpers', () => {
  describe('describeError', () => {
    it('returns the message of an Error', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
    });

    it('handles non-Error values', () => {
      expect(describeError('plain string')).toBe('plain string');
      expect(describeError({ code: 'E_FAIL' })).toBe('{"code":"E_FAIL"}');
    });
  });

  describe('redactSecrets', () => {
    it('masks exact secret values', () => {
      const text =
        'sendMessage failed for https://tapi.bale.ai/botbale-token/sendMessage';

      expect(redactSecrets(text, ['bale-token'])).not.toContain('bale-token');
    });

    it('masks bot-token shaped fragments even without knowing the secret', () => {
      const text =
        'GET https://api.telegram.org/bot123456789:AAG-super-secret-value/sendMessage failed';

      const redacted = redactSecrets(text, []);
      expect(redacted).not.toContain('AAG-super-secret-value');
      expect(redacted).toContain('bot***');
    });
  });

  describe('sanitizeUrl', () => {
    it('drops query string, hash and credentials', () => {
      expect(
        sanitizeUrl(
          'https://user:pass@api.example.com/v1/prices?api_key=supersecret#x',
        ),
      ).toBe('https://api.example.com/v1/prices');
    });

    it('returns a placeholder for an invalid url', () => {
      expect(sanitizeUrl('not a url')).toBe('<invalid-url>');
    });
  });

  describe('truncate', () => {
    it('keeps short strings untouched and shortens long ones', () => {
      expect(truncate('short', 10)).toBe('short');
      expect(truncate('0123456789abc', 10)).toBe('0123456789…');
    });
  });
});
