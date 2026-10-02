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
