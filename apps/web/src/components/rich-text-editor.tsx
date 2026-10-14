'use client';

import { cx } from '@studyhub/ui';
import { EditorContent, type JSONContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, Heading2, Heading3, Italic, Link2, List, ListOrdered, Quote } from 'lucide-react';
import type { ReactNode } from 'react';

export interface RichTextEditorTexts {
  toolbar: string;
  bold: string;
  italic: string;
  heading: string;
  bulletList: string;
  orderedList: string;
  quote: string;
  code: string;
  link: string;
  linkPrompt: string;
}

/**
 * Rich-text editor (F10, S-T07). Only the node and mark types the server allows can be created here:
 * headings 2–4, lists, quotes, code blocks, bold, italic, strike, inline code and http(s)/mailto links.
 * The server validates and normalises the JSON again on save, so this is a convenience, not a guard.
 */
export function RichTextEditor({
  id,
  labelledBy,
  describedBy,
  initial,
  onChange,
  texts,
  invalid = false,
}: {
  id: string;
  labelledBy: string;
  describedBy?: string | undefined;
  initial: unknown;
  onChange: (doc: JSONContent) => void;
  texts: RichTextEditorTexts;
  invalid?: boolean;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['http', 'https', 'mailto'],
          isAllowedUri: (url) => /^(https?:\/\/|mailto:)/i.test(url),
          HTMLAttributes: { rel: 'noopener noreferrer nofollow ugc', target: null },
        },
      }),
    ],
    content: (initial as JSONContent | null) ?? '',
    editorProps: {
      attributes: {
        id,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-labelledby': labelledBy,
        ...(describedBy !== undefined && { 'aria-describedby': describedBy }),
        ...(invalid && { 'aria-invalid': 'true' }),
        class: 'prose-studyhub min-h-48 px-3 py-2 focus:outline-none flex flex-col gap-3',
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current === null
        ? null
        : {
            bold: current.isActive('bold'),
            italic: current.isActive('italic'),
            h2: current.isActive('heading', { level: 2 }),
            h3: current.isActive('heading', { level: 3 }),
            bullet: current.isActive('bulletList'),
            ordered: current.isActive('orderedList'),
            quote: current.isActive('blockquote'),
            code: current.isActive('codeBlock'),
            link: current.isActive('link'),
          },
  });

  const tool = (label: string, active: boolean | undefined, icon: ReactNode, run: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active === true}
      disabled={editor === null}
      onClick={run}
      className={cx(
        'inline-flex size-9 items-center justify-center rounded-sm text-ink hover:bg-sunken',
        active === true && 'bg-accent-soft',
      )}
    >
      {icon}
    </button>
  );

  const icon = 'size-4';
  return (
    <div
      className={cx(
        'rounded-md border bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
        invalid ? 'border-danger' : 'border-strong',
      )}
    >
      <div
        role="toolbar"
        aria-label={texts.toolbar}
        aria-controls={id}
        className="flex flex-wrap gap-1 border-b border-line p-1"
      >
        {tool(texts.bold, state?.bold, <Bold aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleBold().run(),
        )}
        {tool(texts.italic, state?.italic, <Italic aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleItalic().run(),
        )}
        {tool(`${texts.heading} 2`, state?.h2, <Heading2 aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleHeading({ level: 2 }).run(),
        )}
        {tool(`${texts.heading} 3`, state?.h3, <Heading3 aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleHeading({ level: 3 }).run(),
        )}
        {tool(texts.bulletList, state?.bullet, <List aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleBulletList().run(),
        )}
        {tool(texts.orderedList, state?.ordered, <ListOrdered aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleOrderedList().run(),
        )}
        {tool(texts.quote, state?.quote, <Quote aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleBlockquote().run(),
        )}
        {tool(texts.code, state?.code, <Code aria-hidden="true" className={icon} />, () =>
          editor?.chain().focus().toggleCodeBlock().run(),
        )}
        {tool(texts.link, state?.link, <Link2 aria-hidden="true" className={icon} />, () => {
          if (editor === null) return;
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const href = window.prompt(texts.linkPrompt)?.trim();
          if (href !== undefined && /^(https?:\/\/|mailto:)/i.test(href)) {
            editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
          }
        })}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
