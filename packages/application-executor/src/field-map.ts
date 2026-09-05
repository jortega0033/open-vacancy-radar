import { z } from 'zod';

/**
 * The field-map schema (#196 §2.3): the *only* output the text-only generation session produces.
 * It is an assignment between two closed sets the deterministic executor already owns --
 * `fieldRef`/`optionRef` come from a `FormSnapshot` this package minted, `artifactId` comes from
 * the attempt's own registered artifacts (#198/#199) -- never a string the model authored. The
 * generation session cannot name a selector, a URL, a file path, or a raw value.
 *
 * `.strict()` matters here for the same reason it does across this app's other trust boundaries
 * (`packages/shared/src/mcp.ts`, `apps/desktop/electron/workspace/validate.ts`'s allow-list
 * discipline): an unknown key is a rejection, not a silently dropped field.
 */

const FIELD_REF_PATTERN = /^f[0-9a-f]{16}$/u;
const OPTION_REF_PATTERN = /^o[0-9a-f]{16}$/u;
const VALUE_REF_PATTERN = /^v[0-9a-f]{16}$/u;

/** #196 §6.1's bound on assignment count, matching the discipline of every other closed-set
 * validator in this app (e.g. `McpProviderPolicy.maximumPayloadBytes`). */
export const MAX_FIELD_MAP_ENTRIES = 200;

const fieldRefSchema = z.string().regex(FIELD_REF_PATTERN, 'must be a fieldRef minted by a FormSnapshot');
const optionRefSchema = z.string().regex(OPTION_REF_PATTERN, 'must be an optionRef minted by a FormSnapshot');
const valueRefSchema = z.string().regex(VALUE_REF_PATTERN, 'must be a valueRef from the attempt value table');

const assignmentSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), valueRef: valueRefSchema }).strict(),
  z.object({ kind: z.literal('option'), optionRef: optionRefSchema }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('skip'), reason: z.enum(['no_source_value', 'not_applicable']) }).strict(),
]);

export const fieldMapSchema = z
  .object({
    attemptId: z.string().uuid(),
    snapshotGeneration: z.number().int().nonnegative(),
    assignments: z
      .array(z.object({ fieldRef: fieldRefSchema, source: assignmentSourceSchema }).strict())
      .max(MAX_FIELD_MAP_ENTRIES),
    unmapped: z
      .array(
        z
          .object({
            fieldRef: fieldRefSchema,
            reason: z.enum(['needs_user', 'credential_field', 'consent_field', 'unrecognized']),
          })
          .strict(),
      )
      .max(MAX_FIELD_MAP_ENTRIES),
  })
  .strict();

export type FieldMap = z.infer<typeof fieldMapSchema>;
export type FieldAssignment = FieldMap['assignments'][number];
export type UnmappedField = FieldMap['unmapped'][number];

/** Parses raw JSON (the generation session's response) into a `FieldMap`, or `null` on any
 * shape violation. Never throws: a malformed field map is Domain B's job to refuse with a
 * specific reason (see `validate.ts`), not this parser's job to explain. */
export function parseFieldMap(raw: unknown): FieldMap | null {
  const result = fieldMapSchema.safeParse(raw);
  return result.success ? result.data : null;
}
