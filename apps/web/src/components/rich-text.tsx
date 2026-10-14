import type { ReactNode } from 'react';

/**
 * Renders a stored rich-text document (allowlisted and sanitised by the API, F10 AC 1) as React elements.
 * Only known node and mark types render; anything else is dropped, never interpreted. There is no HTML
 * string anywhere, so nothing can inject markup or script.
 */
interface Node {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: { href?: unknown } }[];
  content?: unknown[];
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function renderText(node: Node, key: number): ReactNode {
  let element: ReactNode = node.text ?? '';
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        element = <strong>{element}</strong>;
        break;
      case 'italic':
        element = <em>{element}</em>;
        break;
      case 'strike':
        element = <s>{element}</s>;
        break;
      case 'code':
        element = <code className="rounded-sm bg-sunken px-1 font-mono text-body-sm">{element}</code>;
        break;
      case 'link': {
        const href =
          typeof mark.attrs?.href === 'string' && SAFE_HREF.test(mark.attrs.href) ? mark.attrs.href : null;
        if (href !== null) {
          element = (
            <a href={href} rel="noopener noreferrer nofollow ugc" target="_blank">
              {element}
            </a>
          );
        }
        break;
      }
    }
  }
  return <span key={key}>{element}</span>;
}

/** Signed URLs for `asset:{id}` images, keyed by asset id (the course player passes them). */
type Images = Readonly<Record<string, string>>;

function renderNode(raw: unknown, key: number, images: Images): ReactNode {
  if (typeof raw !== 'object' || raw === null) return null;
  const node = raw as Node;
  if (node.type === 'text') return renderText(node, key);
  const children = Array.isArray(node.content)
    ? node.content.map((child, index) => renderNode(child, index, images))
    : null;
  switch (node.type) {
    case 'doc':
      return <div key={key}>{children}</div>;
    case 'paragraph':
      return <p key={key}>{children}</p>;
    case 'heading': {
      const level = node.attrs?.level === 3 ? 3 : node.attrs?.level === 4 ? 4 : 2;
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
      return (
        <Tag key={key} className={level === 2 ? 'text-h2' : 'text-h3'}>
          {children}
        </Tag>
      );
    }
    case 'bulletList':
      return (
        <ul key={key} className="list-disc ps-6">
          {children}
        </ul>
      );
    case 'orderedList':
      return (
        <ol
          key={key}
          className="list-decimal ps-6"
          start={typeof node.attrs?.start === 'number' ? node.attrs.start : undefined}
        >
          {children}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{children}</li>;
    case 'blockquote':
      return (
        <blockquote key={key} className="border-s-[3px] border-line ps-4 text-muted">
          {children}
        </blockquote>
      );
    case 'codeBlock':
      return (
        <pre key={key} className="overflow-x-auto rounded-md bg-sunken p-3 font-mono text-body-sm">
          <code>{children}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr key={key} className="border-line" />;
    case 'hardBreak':
      return <br key={key} />;
    case 'image': {
      // Only images uploaded to this school (asset:{id}) with a signed URL from the API render.
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const url = src.startsWith('asset:') ? images[src.slice('asset:'.length)] : undefined;
      if (url === undefined) return null;
      return (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed object-storage URL
        <img
          key={key}
          src={url}
          alt={typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''}
          loading="lazy"
          className="h-auto max-w-full rounded-md border border-line"
        />
      );
    }
    default:
      // Unknown types are dropped, never interpreted.
      return null;
  }
}

export function RichText({
  doc,
  className,
  images = {},
}: {
  doc: unknown;
  className?: string;
  images?: Images;
}) {
  if (doc === null || doc === undefined) return null;
  return <div className={`flex flex-col gap-3 ${className ?? ''}`}>{renderNode(doc, 0, images)}</div>;
}
