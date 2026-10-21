import { describe, expect, it } from 'vitest';

import { canDownload, isProtected, viewableInBrowser } from './content-policy';

describe('content protection and downloads', () => {
  it('protects courses by default, and lets the tutor turn it off only while they choose', () => {
    expect(isProtected('TUTOR_CHOOSES', null)).toBe(true);
    expect(isProtected('TUTOR_CHOOSES', false)).toBe(false);
    expect(isProtected('ALWAYS', false)).toBe(true);
    expect(isProtected('NEVER', true)).toBe(false);
  });

  it('follows the tutor’s per-lesson choice unless the school decides', () => {
    expect(canDownload('TUTOR_CHOOSES', true)).toBe(true);
    expect(canDownload('TUTOR_CHOOSES', false)).toBe(false);
    expect(canDownload('ALWAYS', false)).toBe(true);
    expect(canDownload('NEVER', true)).toBe(false);
  });

  it('opens PDFs and images in the browser, not office files', () => {
    expect(viewableInBrowser('application/pdf')).toBe(true);
    expect(viewableInBrowser('image/png')).toBe(true);
    expect(viewableInBrowser('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      false,
    );
  });
});
