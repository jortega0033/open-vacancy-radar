import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { atsProviderSchema, mappingConfidenceSchema } from '../domain/models.js';

const evidenceUrlsSchema = z.array(
  z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
);

export const companyMappingFileSchema = z.object({
  version: z.string().min(1),
  verifiedAt: z.iso.datetime(),
  mappings: z.array(
    z.object({
      brandName: z.string().min(1),
      domain: z.string().trim().toLowerCase().min(3),
      mappingConfidence: mappingConfidenceSchema,
      mappingSource: z.string().min(1),
      evidenceUrls: evidenceUrlsSchema.min(1),
      scanEnabled: z.boolean(),
      sponsors: z
        .array(
          z.object({
            legalName: z.string().min(1),
            kvkNumber: z.string().regex(/^\d{8}$/),
            confidence: mappingConfidenceSchema,
            source: z.string().min(1),
            evidenceUrls: evidenceUrlsSchema.min(1),
          }),
        )
        .min(1),
      careerSources: z.array(
        z
          .object({
          sourceType: z.string().min(1),
          provider: atsProviderSchema,
          baseUrl: z.url(),
          boardIdentifier: z.string().min(1).nullable(),
          discoveryMethod: z.string().min(1),
          evidenceUrls: evidenceUrlsSchema.min(1),
          lifecycleAuthoritative: z.boolean().optional(),
          status: z.enum(['active', 'blocked', 'manual_review', 'unsupported', 'error']),
          statusDiagnostic: z
            .object({
              reason: z.string().min(1),
              observedAt: z.iso.datetime(),
              httpStatus: z.number().int().min(100).max(599).nullable(),
            })
            .optional(),
        })
          .superRefine((source, context) => {
            if (
              ['blocked', 'manual_review'].includes(source.status) &&
              source.statusDiagnostic === undefined
            ) {
              context.addIssue({
                code: 'custom',
                message: `${source.status} sources require a statusDiagnostic`,
                path: ['statusDiagnostic'],
              });
            }
            if (source.provider === 'json_ld') {
              let seedUrl: URL;
              let detailPrefix: URL;
              try {
                seedUrl = new URL(source.baseUrl);
                detailPrefix = new URL(source.boardIdentifier ?? '', seedUrl);
              } catch {
                context.addIssue({
                  code: 'custom',
                  message: 'json_ld sources require a valid detail URL prefix',
                  path: ['boardIdentifier'],
                });
                return;
              }
              const normalizedPath = detailPrefix.pathname.replace(/\/+$/u, '');
              if (
                source.boardIdentifier === null ||
                !['http:', 'https:'].includes(seedUrl.protocol) ||
                seedUrl.username !== '' ||
                seedUrl.password !== '' ||
                detailPrefix.origin !== seedUrl.origin ||
                detailPrefix.username !== '' ||
                detailPrefix.password !== '' ||
                detailPrefix.search.length > 0 ||
                detailPrefix.hash.length > 0 ||
                normalizedPath.length === 0
              ) {
                context.addIssue({
                  code: 'custom',
                  message:
                    'json_ld boardIdentifier must be a same-origin HTTP(S) detail-path prefix without query or fragment',
                  path: ['boardIdentifier'],
                });
              }
            }
          }),
      ),
    }),
  ),
});
export type CompanyMappingFile = z.infer<typeof companyMappingFileSchema>;

export async function loadCompanyMappings(
  filePath = path.resolve(process.cwd(), 'config/company-mappings-v1.json'),
): Promise<CompanyMappingFile> {
  return companyMappingFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
}
