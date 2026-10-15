/**
 * Formats a raw catalogue message where next-intl isn't available (web client components): `{name}` placeholders and ICU plurals
 * (`{count, plural, =0 {…} one {# item} other {# items}}`, `#` = the number). Server components use
 * next-intl; client components receive raw strings (see studio-texts.ts and learn-texts.ts).
 */
export function formatMessage(
  template: string,
  values: Record<string, string | number> = {},
  locale = 'en',
): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf('{', i);
    if (start === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, start);
    const end = matchingBrace(template, start);
    const inner = template.slice(start + 1, end);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(inner);
    if (plural !== null) {
      const value = Number(values[plural[1]!] ?? 0);
      out += choosePlural(plural[2]!, value, locale).replace(
        /#/g,
        new Intl.NumberFormat(locale).format(value),
      );
    } else {
      const key = inner.trim();
      out += key in values ? String(values[key]) : `{${inner}}`;
    }
    i = end + 1;
  }
  return out;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function choosePlural(cases: string, value: number, locale: string): string {
  const options = new Map<string, string>();
  const pattern = /\s*(=\d+|\w+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cases)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingBrace(cases, open);
    options.set(match[1]!, cases.slice(open + 1, close));
    pattern.lastIndex = close + 1;
  }
  return (
    options.get(`=${value}`) ??
    options.get(new Intl.PluralRules(locale).select(value)) ??
    options.get('other') ??
    ''
  );
}
