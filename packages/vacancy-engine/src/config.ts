import path from 'node:path';

import { z } from 'zod';

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const environmentSchema = z
  .object({
    DATABASE_PATH: z.string().min(1).default('.data/vacancy-engine.db'),
    SCAN_BATCH_SIZE: positiveInteger(50),
    GLOBAL_CONCURRENCY: positiveInteger(6),
    PER_DOMAIN_CONCURRENCY: positiveInteger(1),
    REQUEST_TIMEOUT_MS: positiveInteger(15_000),
    REQUEST_QUEUE_TIMEOUT_MS: positiveInteger(120_000),
    MAX_RESPONSE_BYTES: positiveInteger(16 * 1024 * 1024),
    MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    HTTP_CACHE_DIR: z.string().min(1).default('.cache/http'),
    HTTP_CACHE_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
    SPONSOR_BASELINE_MAX_AGE_DAYS: z.coerce.number().int().min(7).max(180).default(45),
    USER_AGENT: z
      .string()
      .min(10)
      .default('OpenVacancyRadar/0.1 (+personal vacancy research; contact: configure-your-email)'),
    AI_ENABLED: booleanFromEnvironment.default(false),
    AI_BASE_URL: z.string().optional().default(''),
    AI_API_KEY: z.string().optional().default(''),
    AI_MODEL: z.string().optional().default(''),
    BRAVE_SEARCH_API_KEY: z.string().optional().default(''),
    BRAVE_SEARCH_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(25),
    BRAVE_SEARCH_MAX_REQUESTS: z.coerce.number().int().min(1).max(1_000).default(25),
    BRAVE_SEARCH_RECHECK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    ADZUNA_APP_ID: z.string().optional().default(''),
    ADZUNA_APP_KEY: z.string().optional().default(''),
    JOOBLE_API_KEY: z.string().optional().default(''),
    REED_API_KEY: z.string().optional().default(''),
    JOBSPIPE_API_KEY: z.string().optional().default(''),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    REPORT_MIN_SCORE: z.coerce.number().int().min(70).max(100).default(70),
    MAX_POSTING_AGE_DAYS: z.coerce.number().int().min(30).max(730).default(365),
  })
  .superRefine((environment, context) => {
    if (!environment.AI_ENABLED) return;
    for (const key of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'] as const) {
      if (environment[key].trim().length === 0) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when AI_ENABLED=true`,
        });
      }
    }
  });

export type AppConfig = {
  databasePath: string;
  scanBatchSize: number;
  globalConcurrency: number;
  perDomainConcurrency: number;
  requestTimeoutMs: number;
  requestQueueTimeoutMs: number;
  maxResponseBytes: number;
  maxRetries: number;
  httpCacheDirectory: string;
  httpCacheRetentionDays: number;
  sponsorBaselineMaxAgeDays: number;
  userAgent: string;
  ai: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  braveSearch: {
    apiKey: string;
    batchSize: number;
    maxRequests: number;
    recheckDays: number;
  };
  keyedDiscovery: {
    adzunaAppId: string;
    adzunaAppKey: string;
    joobleApiKey: string;
    reedApiKey: string;
    jobspipeApiKey: string;
  };
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  reportMinScore: number;
  maxPostingAgeDays: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env, projectRoot = process.cwd()): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const cacheDirectory = path.resolve(projectRoot, parsed.HTTP_CACHE_DIR);
  const relativeCacheDirectory = path.relative(projectRoot, cacheDirectory);
  if (relativeCacheDirectory.startsWith('..') || path.isAbsolute(relativeCacheDirectory)) {
    throw new Error('HTTP_CACHE_DIR must remain inside the project directory');
  }

  const databasePath = path.resolve(projectRoot, parsed.DATABASE_PATH);
  const relativeDatabasePath = path.relative(projectRoot, databasePath);
  if (
    relativeDatabasePath.length === 0 ||
    relativeDatabasePath.startsWith('..') ||
    path.isAbsolute(relativeDatabasePath)
  ) {
    throw new Error('DATABASE_PATH must remain inside the project directory');
  }

  return {
    databasePath,
    scanBatchSize: parsed.SCAN_BATCH_SIZE,
    globalConcurrency: parsed.GLOBAL_CONCURRENCY,
    perDomainConcurrency: parsed.PER_DOMAIN_CONCURRENCY,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    requestQueueTimeoutMs: parsed.REQUEST_QUEUE_TIMEOUT_MS,
    maxResponseBytes: parsed.MAX_RESPONSE_BYTES,
    maxRetries: parsed.MAX_RETRIES,
    httpCacheDirectory: cacheDirectory,
    httpCacheRetentionDays: parsed.HTTP_CACHE_RETENTION_DAYS,
    sponsorBaselineMaxAgeDays: parsed.SPONSOR_BASELINE_MAX_AGE_DAYS,
    userAgent: parsed.USER_AGENT,
    ai: {
      enabled: parsed.AI_ENABLED,
      baseUrl: parsed.AI_BASE_URL,
      apiKey: parsed.AI_API_KEY,
      model: parsed.AI_MODEL,
    },
    braveSearch: {
      apiKey: parsed.BRAVE_SEARCH_API_KEY,
      batchSize: parsed.BRAVE_SEARCH_BATCH_SIZE,
      maxRequests: parsed.BRAVE_SEARCH_MAX_REQUESTS,
      recheckDays: parsed.BRAVE_SEARCH_RECHECK_DAYS,
    },
    keyedDiscovery: {
      adzunaAppId: parsed.ADZUNA_APP_ID,
      adzunaAppKey: parsed.ADZUNA_APP_KEY,
      joobleApiKey: parsed.JOOBLE_API_KEY,
      reedApiKey: parsed.REED_API_KEY,
      jobspipeApiKey: parsed.JOBSPIPE_API_KEY,
    },
    logLevel: parsed.LOG_LEVEL,
    reportMinScore: parsed.REPORT_MIN_SCORE,
    maxPostingAgeDays: parsed.MAX_POSTING_AGE_DAYS,
  };
}
