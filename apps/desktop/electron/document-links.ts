/**
 * One definition of "a link this app is willing to put in, or accept out of, a generated document"
 * (#276), shared by the templates that render links and the validator that checks they survived.
 *
 * Dependency-free on purpose: `resume-html.ts` is pure string building with no Node or Electron
 * API, and importing the acceptance validator (which needs `node:crypto` and pdf.js) into it just
 * to reuse this predicate would drag both into every template consumer.
 */

/** http(s) and mailto are the only schemes a document this app produces has any business linking
 * to. Anything else surviving into a finished PDF (a `javascript:` action, a relative path that
 * never resolved against the renderer's own data: URL) is a template bug or an injection attempt,
 * and both are refusals rather than warnings. */
const ACCEPTED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

export function isAcceptableDocumentLink(url: string): boolean {
  try {
    return ACCEPTED_LINK_SCHEMES.includes(new URL(url.trim()).protocol);
  } catch {
    return false;
  }
}

/** Compares two absolute URLs as the same link target, ignoring the differences a renderer is free
 * to introduce: case in the scheme and host, and a trailing slash pdf.js adds when normalizing. */
export function sameDocumentLink(a: string, b: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/\/+$/, '');
  return normalize(a) === normalize(b);
}
