import { describe, expect, it } from 'vitest';

import { richTextAssetIds, richTextSchema, richTextToPlain, sanitizeRichText } from './rich-text';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (text: string, marks?: unknown[]) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks && { marks }) }],
});

describe('rich text allowlist (F10 AC 1)', () => {
  it('accepts headings, lists, code, links and school images', () => {
    const value = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Cells' }] },
      p('See ', [{ type: 'bold' }]),
      p('the guide', [{ type: 'link', attrs: { href: 'https://example.com/guide' } }]),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('One')] }] },
      { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print(1)' }] },
      { type: 'image', attrs: { src: 'asset:0d6c2b1e-0000-4000-8000-000000000001', alt: 'A cell' } },
    );
    expect(richTextSchema.safeParse(value).success).toBe(true);
    expect(richTextAssetIds(value)).toEqual(['0d6c2b1e-0000-4000-8000-000000000001']);
  });

  it.each([
    ['javascript: links', doc(p('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))],
    ['data: links', doc(p('x', [{ type: 'link', attrs: { href: 'data:text/html,<script>' } }]))],
    ['unknown nodes (raw HTML)', doc({ type: 'html', attrs: { value: '<img src=x onerror=alert(1)>' } })],
    ['event-handler attributes', doc({ type: 'paragraph', attrs: { onclick: 'alert(1)' }, content: [] })],
    ['external images', doc({ type: 'image', attrs: { src: 'https://tracker.example/pixel.gif' } })],
    ['extra keys on nodes', doc({ type: 'paragraph', content: [], style: 'x' })],
    ['unknown marks', doc(p('x', [{ type: 'span', attrs: { style: 'x' } }]))],
    ['h1 (one per page is the page title)', doc({ type: 'heading', attrs: { level: 1 }, content: [] })],
    ['a non-document root', p('x')],
  ])('rejects %s', (_name, value) => {
    expect(richTextSchema.safeParse(value).success).toBe(false);
  });

  it('rejects documents nested too deeply or too large', () => {
    let deep: unknown = { type: 'text', text: 'x' };
    for (let i = 0; i < 20; i += 1) deep = { type: 'blockquote', content: [deep] };
    expect(richTextSchema.safeParse(doc(deep)).success).toBe(false);
    expect(
      richTextSchema.safeParse(doc(...Array.from({ length: 200 }, () => p('x'.repeat(1500))))).success,
    ).toBe(false);
  });

  it('extracts plain text', () => {
    expect(richTextToPlain(doc(p('Hello'), p('world')))).toBe('Hello world');
  });
});

describe('sanitizeRichText', () => {
  it('keeps only allowlisted attributes and marks', () => {
    const input = {
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 3, type: null }, content: [] },
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [
                { type: 'link', attrs: { href: 'https://a.example', target: '_blank', class: 'evil' } },
              ],
            },
          ],
        },
      ],
    };
    expect(richTextSchema.safeParse(input).success).toBe(true);
    expect(sanitizeRichText(input)).toEqual({
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 3 }, content: [] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://a.example' } }] },
          ],
        },
      ],
    });
  });
});
