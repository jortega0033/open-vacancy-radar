import { describe, expect, it } from 'vitest';
import { renderLetterHtml } from '../electron/letter-html.js';

describe('renderLetterHtml', () => {
  it('renders a complete, valid HTML document', () => {
    const html = renderLetterHtml('Cover Letter', 'Dear hiring team,\n\nI am writing to apply.');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('splits body paragraphs on blank lines into distinct blocks', () => {
    const html = renderLetterHtml('Cover Letter', 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
    expect(html).toContain('<p>Third paragraph.</p>');
  });

  it('escapes HTML-significant characters rather than interpolating them raw', () => {
    const html = renderLetterHtml('<script>alert(1)</script>', 'Body with "quotes" & <tags>.');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('omits the title heading when no title is given, without throwing', () => {
    const html = renderLetterHtml('', 'Just a body.');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('Just a body.');
  });

  it('drops blank runs rather than rendering empty paragraphs', () => {
    const html = renderLetterHtml('Title', 'First.\n\n\n\nSecond.');
    expect(html).not.toMatch(/<p><\/p>/);
    expect(html).toContain('<p>First.</p>');
    expect(html).toContain('<p>Second.</p>');
  });
});
