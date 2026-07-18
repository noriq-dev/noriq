// PLNR-113: decodeURIComponent throws URIError on malformed %-encoding (e.g. `/p/%`).
// Called during hook init and on popstate, an unhandled throw blanked the whole app.
// safeDecode must never throw — it falls back to the raw value.
import { describe, expect, it } from 'vitest';
import { safeDecode } from './store';

describe('safeDecode (PLNR-113)', () => {
  it('decodes valid percent-encoding', () => {
    expect(safeDecode('a%20b')).toBe('a b');
    expect(safeDecode('PLNR')).toBe('PLNR');
  });

  it('returns the raw value instead of throwing on malformed encoding', () => {
    expect(() => safeDecode('%')).not.toThrow();
    expect(safeDecode('%')).toBe('%');
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
  });
});
