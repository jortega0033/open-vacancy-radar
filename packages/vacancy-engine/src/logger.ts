import pino, { type Logger } from 'pino';

import type { AppConfig } from './config.js';

export function createLogger(config: Pick<AppConfig, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        'authorization',
        'cookie',
        'headers.authorization',
        'headers.cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        '*.apiKey',
        'apiKey',
        'AI_API_KEY',
      ],
      censor: '[REDACTED]',
    },
  });
}
