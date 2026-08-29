import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { normalizeLegalName } from '../ind/normalize.js';

export function isForbiddenDiscoveryHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '');
  return normalized === 'linkedin.com' || normalized.endsWith('.linkedin.com');
}

const publicEvidenceUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    context.addIssue({ code: 'custom', message: 'evidence URLs must be credential-free HTTP(S)' });
  }
});

const officialUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    context.addIssue({
      code: 'custom',
      message: 'officialUrl must be credential-free HTTP(S) without query or fragment',
    });
  }
  if (isForbiddenDiscoveryHostname(url.hostname)) {
    context.addIssue({
      code: 'custom',
      message: 'LinkedIn is forbidden as a discovery target',
    });
  }
});

export const companyDomainCandidateFileSchema = z
  .object({
    version: z.string().min(1),
    verifiedAt: z.iso.datetime(),
    candidates: z.array(
      z.object({
        legalName: z.string().trim().min(1),
        kvkNumber: z.string().regex(/^\d{8}$/u),
        brandName: z.string().trim().min(1),
        officialUrl: officialUrlSchema,
        confidence: z.enum(['high', 'medium', 'low']),
        source: z.string().trim().min(1),
        evidenceUrls: z.array(publicEvidenceUrlSchema).min(1),
        priority: z.number().int().min(0).max(100).default(0),
      }),
    ),
  })
  .superRefine((file, context) => {
    const identities = new Set<string>();
    file.candidates.forEach((candidate, index) => {
      const identity = `${candidate.kvkNumber}:${normalizeLegalName(candidate.legalName)}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', index],
          message: 'candidate file contains a duplicate sponsor identity',
        });
      }
      identities.add(identity);
    });
  });

export type CompanyDomainCandidateFile = z.infer<typeof companyDomainCandidateFileSchema>;
export type CompanyDomainCandidate = CompanyDomainCandidateFile['candidates'][number];

export function normalizeOfficialUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString();
}

/** Content identity; file version and review time are stored as provenance. */
export function hashDomainCandidate(candidate: CompanyDomainCandidate): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...candidate,
        officialUrl: normalizeOfficialUrl(candidate.officialUrl),
      }),
    )
    .digest('hex');
}

export async function loadCompanyDomainCandidates(
  filePath = path.resolve(process.cwd(), 'config/company-domain-candidates-v1.json'),
): Promise<CompanyDomainCandidateFile> {
  return companyDomainCandidateFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
}
