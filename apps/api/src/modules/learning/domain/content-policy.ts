/**
 * Content protection and downloads (docs/design/content-protection.md). The school decides, or lets the
 * tutor decide: protection per course (protected unless the tutor turns it off) and downloads per lesson.
 * Owners and administrators previewing a course are never limited.
 */
export type ContentPolicy = 'TUTOR_CHOOSES' | 'ALWAYS' | 'NEVER';

export function isProtected(policy: ContentPolicy, courseChoice: boolean | null): boolean {
  if (policy === 'ALWAYS') return true;
  if (policy === 'NEVER') return false;
  return courseChoice ?? true;
}

export function canDownload(policy: ContentPolicy, lessonDownloadable: boolean): boolean {
  if (policy === 'ALWAYS') return true;
  if (policy === 'NEVER') return false;
  return lessonDownloadable;
}

/** Files a browser shows by itself, so a stream-and-view-only lesson can still open them. */
export function viewableInBrowser(mime: string): boolean {
  return mime === 'application/pdf' || mime.startsWith('image/');
}
