import { z } from 'zod';

/**
 * Rich text (F10, AC 1): ProseMirror JSON checked against an ALLOWLIST. Only these node and mark types,
 * these attributes, and safe link targets exist; there is no HTML anywhere, so script and inline event
 * handlers are impossible by construction. Used by the API (validation on save) and the web editor.
 */
export const MAX_RICH_TEXT_BYTES = 200_000;
const MAX_DEPTH = 12;

const safeHref = z
  .string()
  .max(2000)
  .refine((href) => /^(https?:\/\/|mailto:)/i.test(href), {
    message: 'Links must start with https://, http:// or mailto:',
  });

const markSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('strike') }).strict(),
  z.object({ type: z.literal('code') }).strict(),
  z
    .object({
      type: z.literal('link'),
      attrs: z.object({ href: safeHref }).strip(),
    })
    .strict(),
]);

const textNode = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(20_000),
    marks: z.array(markSchema).max(5).optional(),
  })
  .strict();

export type RichTextNode =
  z.infer<typeof textNode> | { type: string; attrs?: Record<string, unknown>; content?: RichTextNode[] };

/** Block and inline containers with the attributes each may carry. */
const CONTAINERS: Record<string, z.ZodType | null> = {
  doc: null,
  paragraph: null,
  blockquote: null,
  bulletList: null,
  orderedList: z.object({ start: z.number().int().min(1).max(10_000).optional() }).strip(),
  listItem: null,
  heading: z.object({ level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }).strip(),
  codeBlock: z
    .object({
      language: z
        .string()
        .regex(/^[a-z0-9+#-]{0,20}$/)
        .nullable()
        .optional(),
    })
    .strip(),
  horizontalRule: null,
  hardBreak: null,
  // Images reference an asset of this school (asset:<uuid>); the server checks it exists here.
  image: z
    .object({
      src: z.string().regex(/^asset:[0-9a-f-]{36}$/, 'Images must be uploaded to this school'),
      alt: z.string().max(300).nullable().optional(),
    })
    .strip(),
};

const LEAVES = new Set(['horizontalRule', 'hardBreak', 'image']);

function check(node: unknown, depth: number, ctx: z.RefinementCtx, path: (string | number)[]): void {
  if (depth > MAX_DEPTH) {
    ctx.addIssue({ code: 'custom', path, message: 'The content is nested too deeply' });
    return;
  }
  if (typeof node !== 'object' || node === null) {
    ctx.addIssue({ code: 'custom', path, message: 'Invalid content' });
    return;
  }
  const { type } = node as { type?: unknown };
  if (type === 'text') {
    const parsed = textNode.safeParse(node);
    if (!parsed.success)
      ctx.addIssue({ code: 'custom', path, message: parsed.error.issues[0]?.message ?? 'Invalid text' });
    return;
  }
  if (typeof type !== 'string' || !(type in CONTAINERS)) {
    ctx.addIssue({ code: 'custom', path, message: `Content type "${String(type)}" is not allowed` });
    return;
  }
  const allowedKeys = new Set(['type', 'attrs', 'content']);
  for (const key of Object.keys(node)) {
    if (!allowedKeys.has(key))
      ctx.addIssue({ code: 'custom', path: [...path, key], message: `"${key}" is not allowed` });
  }
  const attrsSchema = CONTAINERS[type] ?? null;
  const { attrs, content } = node as { attrs?: unknown; content?: unknown };
  if (attrs !== undefined && attrs !== null) {
    if (attrsSchema === null) {
      // Editors send empty defaults (e.g. `{ textAlign: null }`); anything with a value is refused.
      if (typeof attrs !== 'object' || Object.values(attrs as object).some((value) => value !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'attrs'],
          message: 'Attributes are not allowed here',
        });
      }
    } else {
      const parsed = attrsSchema.safeParse(attrs);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'attrs'],
          message: parsed.error.issues[0]?.message ?? 'Invalid attributes',
        });
      }
    }
  } else if (type === 'heading' || type === 'image') {
    ctx.addIssue({ code: 'custom', path: [...path, 'attrs'], message: 'Attributes are required' });
  }
  if (content !== undefined) {
    if (LEAVES.has(type) || !Array.isArray(content) || content.length > 2000) {
      ctx.addIssue({ code: 'custom', path: [...path, 'content'], message: 'Invalid content' });
      return;
    }
    content.forEach((child, index) => check(child, depth + 1, ctx, [...path, 'content', index]));
  }
}

export const richTextSchema = z.unknown().superRefine((value, ctx) => {
  if (JSON.stringify(value ?? null).length > MAX_RICH_TEXT_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'The content is too long' });
    return;
  }
  if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'doc') {
    ctx.addIssue({ code: 'custom', message: 'The content must be a document' });
    return;
  }
  check(value, 0, ctx, []);
}) as z.ZodType<RichTextNode>;

/** Plain text of a document (search, reading time, the "description ≥ 200 characters" check). */
/** Attributes kept per node type when a validated document is normalised (everything else is dropped). */
const KEPT_ATTRS: Record<string, readonly string[]> = {
  heading: ['level'],
  orderedList: ['start'],
  codeBlock: ['language'],
  image: ['src', 'alt'],
};

/**
 * The stored form of a VALIDATED document: only allowlisted keys, attributes and marks survive (editors
 * such as Tiptap add harmless extras like a link's `target` or `class`; none of them is ever stored).
 * Call after `richTextSchema` has accepted the value.
 */
export function sanitizeRichText(node: unknown): RichTextNode {
  const source = node as {
    type: string;
    text?: string;
    attrs?: Record<string, unknown>;
    marks?: { type: string; attrs?: { href?: unknown } }[];
    content?: unknown[];
  };
  if (source.type === 'text') {
    const marks = (source.marks ?? []).map((mark) =>
      mark.type === 'link'
        ? { type: 'link' as const, attrs: { href: String(mark.attrs?.href ?? '') } }
        : { type: mark.type },
    );
    return { type: 'text', text: source.text ?? '', ...(marks.length > 0 && { marks }) } as RichTextNode;
  }
  const keep = KEPT_ATTRS[source.type] ?? [];
  const attrs = Object.fromEntries(
    keep
      .filter((key) => source.attrs?.[key] !== undefined && source.attrs[key] !== null)
      .map((key) => [key, source.attrs![key]]),
  );
  return {
    type: source.type,
    ...(Object.keys(attrs).length > 0 && { attrs }),
    ...(Array.isArray(source.content) && { content: source.content.map(sanitizeRichText) }),
  };
}

export function richTextToPlain(doc: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return;
    const { type, text, content } = node as { type?: string; text?: string; content?: unknown[] };
    if (type === 'text' && typeof text === 'string') parts.push(text);
    if (Array.isArray(content)) {
      content.forEach(walk);
      if (type !== 'doc' && type !== 'text') parts.push(' ');
    }
  };
  walk(doc);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Asset ids referenced by images in a document (the server checks they belong to the school). */
export function richTextAssetIds(doc: unknown): string[] {
  const ids = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return;
    const { type, attrs, content } = node as {
      type?: string;
      attrs?: { src?: unknown };
      content?: unknown[];
    };
    if (type === 'image' && typeof attrs?.src === 'string') ids.add(attrs.src.slice('asset:'.length));
    if (Array.isArray(content)) content.forEach(walk);
  };
  walk(doc);
  return [...ids];
}
