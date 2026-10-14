/**
 * Fills `{name}` placeholders of a raw catalogue message on the client (server components use
 * next-intl; client components receive raw strings). Plural messages are formatted on the server.
 */
export function fill(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
