'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

/** Keys that copy, save, print or open the source while protected content is on screen. */
const BLOCKED_KEYS = new Set(['c', 'x', 's', 'p', 'u']);

/** Seconds between watermark moves, so it can't simply be cropped out of the same spot. */
const MOVE_EVERY_SECONDS = 20;

/**
 * The learner's name over protected content (docs/design/content-protection.md). A browser can't stop
 * screenshots or a phone camera; a visible name on every capture identifies who shared it.
 */
export function Watermark({ text }: { text: string }) {
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setShift((value) => (value + 1) % 4), MOVE_EVERY_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Drawn as a repeating image, not page text: it reads the same on light and dark themes, can't be
  // selected, and isn't mistaken for low-contrast content by accessibility checks.
  const tile = useMemo(() => watermarkTile(text), [text]);
  return (
    <div
      aria-hidden="true"
      data-testid="watermark"
      data-watermark={text}
      className="pointer-events-none absolute inset-0 z-10 select-none"
      style={{
        backgroundImage: `url("${tile}")`,
        backgroundRepeat: 'repeat',
        backgroundPosition: `${shift * 60}px ${shift * 40}px`,
        transition: 'background-position 1s',
      }}
    />
  );
}

const escapeXml = (value: string) => value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** One rotated tile of the watermark text, as an SVG data URL. */
function watermarkTile(text: string): string {
  const width = Math.max(240, text.length * 8 + 60);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="150">` +
    `<text x="20" y="110" transform="rotate(-24 20 110)" fill="#6b7280" fill-opacity="0.22" ` +
    `font-family="system-ui, sans-serif" font-size="14" font-weight="600">${escapeXml(text)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Protected lesson content: the watermark, no selecting, copying, right-click or drag, the copy, save
 * and print shortcuts are off, and printing shows only `notice` (see globals.css). These deter casual
 * copying; they can't stop a determined person, which is why the watermark names the learner.
 */
export function ProtectedContent({
  watermark,
  notice,
  children,
}: {
  watermark: string;
  notice: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const block = (event: Event) => event.preventDefault();
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && BLOCKED_KEYS.has(event.key.toLowerCase()))
        event.preventDefault();
    };
    for (const type of ['contextmenu', 'copy', 'cut', 'dragstart'] as const)
      element.addEventListener(type, block);
    window.addEventListener('keydown', onKey);
    return () => {
      for (const type of ['contextmenu', 'copy', 'cut', 'dragstart'] as const) {
        element.removeEventListener(type, block);
      }
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <>
      <div ref={box} data-protected="" className="relative select-none">
        {children}
        <Watermark text={watermark} />
      </div>
      <p data-protected-notice="" className="text-body">
        {notice}
      </p>
    </>
  );
}
