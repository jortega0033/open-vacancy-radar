import { describe, expect, it } from 'vitest';

import { safeErrorClassification } from '../../src/crawler/errors.js';
import { sanitizeDiagnosticContext } from '../../src/scans/repository.js';

describe('scan diagnostic redaction', () => {
  it('redacts credentials, tokens, and sensitive URL parameters', () => {
    expect(
      sanitizeDiagnosticContext({
        apiKey: 'secret',
        url: 'https://jobs.example.com/api?token=abc&board=public',
        nested: { authorization: 'Bearer private', status: 403 },
      }),
    ).toEqual({
      apiKey: '[REDACTED]',
      url: 'https://jobs.example.com/api?token=%5BREDACTED%5D&board=public',
      nested: { authorization: '[REDACTED]', status: 403 },
    });
  });

  it('classifies cache failures without serializing secret-bearing error details', () => {
    const error = new Error(
      'query failed for https://jobs.example.com?token=secret with body c2VjcmV0',
    );
    error.name = 'DatabaseError';
    const diagnostic = safeErrorClassification(error);

    expect(diagnostic).toEqual({ errorType: 'DatabaseError' });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|token|body/u);
  });

  it('recursively sanitizes arrays and nested objects', () => {
    expect(
      sanitizeDiagnosticContext({
        values: [
          'https://user:pass@example.test/path?token=secret',
          { authorization: 'Bearer secret', note: 'api_key=secret' },
        ],
      }),
    ).toEqual({
      values: [
        'https://example.test/path?token=%5BREDACTED%5D',
        { authorization: '[REDACTED]', note: 'api_key=[REDACTED]' },
      ],
    });
  });
});
