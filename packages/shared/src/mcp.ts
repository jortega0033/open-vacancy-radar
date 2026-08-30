import { z } from 'zod';

export const mcpProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/u);
export type McpProviderId = z.infer<typeof mcpProviderIdSchema>;

export const mcpSearchRequestSchema = z.object({
  providerId: mcpProviderIdSchema,
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export type McpSearchRequest = z.infer<typeof mcpSearchRequestSchema>;

export const mcpCredentialInputSchema = z.object({
  providerId: mcpProviderIdSchema,
  credential: z.string().min(1).max(16_384),
}).strict();
export type McpCredentialInput = z.infer<typeof mcpCredentialInputSchema>;

export const mcpVacancySchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(300),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  }, 'url must be credential-free HTTP(S)'),
  location: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).nullable(),
  employmentType: z.string().trim().max(100).nullable(),
  publishedAt: z.string().datetime().nullable(),
}).strict();
export type McpVacancy = z.infer<typeof mcpVacancySchema>;

export const mcpProviderResultSchema = z.object({ jobs: z.array(mcpVacancySchema).max(50) }).strict();

export const mcpVacancyResultSchema = mcpVacancySchema.extend({
  providerId: mcpProviderIdSchema,
  sourceUrl: z.string().url(),
  attribution: z.string().min(1).max(500),
  policyVersion: z.string().min(1).max(100),
  policyReviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export type McpVacancyResult = z.infer<typeof mcpVacancyResultSchema>;

export const mcpConnectionStatusSchema = z.object({
  providerId: mcpProviderIdSchema,
  enabled: z.boolean(),
  connectionEnabled: z.boolean(),
  searchEnabled: z.boolean(),
  persistenceEnabled: z.boolean(),
  connected: z.boolean(),
  credentialConfigured: z.boolean(),
}).strict();
export type McpConnectionStatus = z.infer<typeof mcpConnectionStatusSchema>;
