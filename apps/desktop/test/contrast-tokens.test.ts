import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Non-text contrast (WCAG 1.4.11, issue #484), computed from the values in tokens.css rather than
 * from a screenshot. Colors are read as text, `oklch()` is converted to sRGB, and translucent
 * borders are composited over the page the way a browser paints them (in gamma-encoded sRGB).
 */
const css = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8');

type Rgb = [number, number, number];

function oklchToSrgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear: Rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return linear.map((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function themeTokens(name: string): Record<string, Rgb> {
  const start = css.indexOf(`name: '${name}'`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  const block = css.slice(start, end);
  const tokens: Record<string, Rgb> = {};
  for (const match of block.matchAll(/--color-([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)(?:\s+([\d.]+))?\)/g)) {
    tokens[match[1] as string] = oklchToSrgb(Number(match[2]) / 100, Number(match[3]), Number(match[4] ?? 0));
  }
  return tokens;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function over(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  return foreground.map((v, i) => v * alpha + (background[i] as number) * (1 - alpha)) as Rgb;
}

function inputBorderAlpha(): number {
  const rule = css.match(/\.input,\s*\.select,\s*\.textarea\s*\{([^}]*)\}/);
  expect(rule).not.toBeNull();
  const mix = (rule?.[1] ?? '').match(/--input-color:\s*color-mix\(in oklab,\s*var\(--color-base-content\)\s+([\d.]+)%,\s*transparent\)/);
  expect(mix).not.toBeNull();
  return Number(mix?.[1]) / 100;
}

describe.each(['openvacancyradar', 'openvacancyradar-dark'])('%s theme', (name) => {
  const tokens = themeTokens(name);
  const base100 = tokens['base-100'] as Rgb;
  const base300 = tokens['base-300'] as Rgb;
  const content = tokens['base-content'] as Rgb;

  it('reads the tokens it checks', () => {
    expect(base100).toBeDefined();
    expect(base300).toBeDefined();
    expect(content).toBeDefined();
  });

  it('draws input, select and textarea borders at 3:1 or more against the page', () => {
    const border = over(content, inputBorderAlpha(), base100);
    expect(contrast(border, base100)).toBeGreaterThanOrEqual(3);
  });

  it('draws the selected row marker at 3:1 or more against the page and the selected row background', () => {
    expect(contrast(content, base100)).toBeGreaterThanOrEqual(3);
    expect(contrast(content, base300)).toBeGreaterThanOrEqual(3);
  });
});

describe('ovr-row-selected', () => {
  it('pairs the stronger background with a 3px inline-start marker in base-content', () => {
    const rule = css.match(/@utility ovr-row-selected\s*\{([\s\S]*?)\n\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/background-color:\s*var\(--color-base-300\)/);
    expect(rule?.[1]).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--color-base-content\)/);
  });
});

describe('reduced motion (issue #497)', () => {
  it('shortens transitions and animations under prefers-reduced-motion: reduce', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start);
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });
});

/**
 * Visible status notices (#692). The follow-ups drawer announces every outcome ("Follow-up added.", "Draft ready to
 * review. Nothing was sent.") in a live region. The text colour is read from the component's own class list, so the
 * exact text/surface pair that ships is the one checked, in both themes. A `*-content` token is the colour of text
 * ON a filled `bg-*` of the same name, so on the plain drawer surface it is white-on-white or dark-on-dark.
 */
const NOTICE_SOURCES = [
  ['follow-ups drawer notice', resolve(__dirname, '../src/components/applications/FollowUpsDrawer.tsx'), 'data-testid="follow-up-notice"'],
] as const;

function noticeTextColor(source: string, marker: string): { token: string; alpha: number } {
  const line = source.split(/\r?\n/).find((candidate) => candidate.includes(marker));
  expect(line, `the element marked ${marker} is in the source`).toBeDefined();
  const classes = (/className="([^"]*)"/.exec(line ?? '')?.[1] ?? '').split(/\s+/);
  const colors = classes
    .map((name) => /^text-([a-z]+(?:-[a-z]+)*)(?:\/(\d+))?$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null && !/^(xs|sm|base|lg|xl|left|right|center|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(match[1] ?? ''));
  expect(colors, 'exactly one text colour class').toHaveLength(1);
  return { token: colors[0]![1] as string, alpha: colors[0]![2] ? Number(colors[0]![2]) / 100 : 1 };
}

describe.each(['openvacancyradar', 'openvacancyradar-dark'])('%s theme: status notice text', (name) => {
  const tokens = themeTokens(name);
  it.each(NOTICE_SOURCES)('%s is readable (4.5:1 or more) on the page and card surfaces', (_label, file, marker) => {
    const { token, alpha } = noticeTextColor(readFileSync(file, 'utf8'), marker);
    expect(tokens[token], `token ${token} exists in ${name}`).toBeDefined();
    for (const surface of ['base-100', 'base-200'] as const) {
      const background = tokens[surface] as Rgb;
      const text = over(tokens[token] as Rgb, alpha, background);
      expect(contrast(text, background), `${token}/${Math.round(alpha * 100)} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it('the status notice contrast check fails for the text-on-fill token the drawer used before', () => {
  // Guards the check itself: success-content on base-100 is the pair that made the notice invisible.
  for (const name of ['openvacancyradar', 'openvacancyradar-dark']) {
    const tokens = themeTokens(name);
    const background = tokens['base-100'] as Rgb;
    expect(contrast(over(tokens['success-content'] as Rgb, 0.8, background), background)).toBeLessThan(4.5);
  }
});
