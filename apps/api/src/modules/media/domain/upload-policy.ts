/**
 * What may be uploaded, for which purpose, and how large (F11, BR-29, BR-64). The platform allowlist and
 * caps are the outer bound; a school's settings can only narrow them. Plans (M9) will add a third bound:
 * the effective limit is min(platform, plan, school).
 */
import type { ContentSettings } from '@studyhub/contracts';

export type AssetPurpose =
  | 'COURSE_COVER'
  | 'AVATAR'
  | 'LESSON_FILE'
  | 'LESSON_IMAGE'
  | 'LESSON_VIDEO'
  // M9 (F39): logos and icons; PNG/JPEG/WebP only (SVG rejected, Q-TEN-13), re-encoded by the pipeline.
  | 'BRANDING';
export type AssetKind = 'IMAGE' | 'DOCUMENT' | 'VIDEO';

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

/** Platform bounds per purpose. */
const PLATFORM: Record<AssetPurpose, { kind: AssetKind; maxBytes: number }> = {
  COURSE_COVER: { kind: 'IMAGE', maxBytes: 5 * MB },
  AVATAR: { kind: 'IMAGE', maxBytes: 5 * MB },
  LESSON_IMAGE: { kind: 'IMAGE', maxBytes: 5 * MB },
  BRANDING: { kind: 'IMAGE', maxBytes: 2 * MB },
  LESSON_FILE: { kind: 'DOCUMENT', maxBytes: 500 * MB },
  LESSON_VIDEO: { kind: 'VIDEO', maxBytes: 20 * GB },
};

export interface UploadRule {
  kind: AssetKind;
  allowedTypes: readonly string[];
  maxBytes: number;
}

/** The effective rule for a purpose in a school (BR-64: limits apply to new uploads). */
export function uploadRule(purpose: AssetPurpose, settings: ContentSettings): UploadRule {
  const platform = PLATFORM[purpose];
  switch (platform.kind) {
    case 'IMAGE':
      return { kind: 'IMAGE', allowedTypes: IMAGE_TYPES, maxBytes: platform.maxBytes };
    case 'DOCUMENT':
      return {
        kind: 'DOCUMENT',
        allowedTypes: settings.allowedUploadTypes,
        maxBytes: Math.min(platform.maxBytes, settings.maxDocumentMb * MB),
      };
    case 'VIDEO':
      return {
        kind: 'VIDEO',
        allowedTypes: VIDEO_TYPES,
        maxBytes: Math.min(platform.maxBytes, Math.floor(settings.maxVideoGb * GB)),
      };
  }
}

export type UploadProblem = 'TYPE_NOT_ALLOWED' | 'TOO_LARGE';

export function uploadProblem(rule: UploadRule, mime: string, sizeBytes: number): UploadProblem | null {
  if (!rule.allowedTypes.includes(mime)) return 'TYPE_NOT_ALLOWED';
  if (sizeBytes > rule.maxBytes) return 'TOO_LARGE';
  return null;
}

/** A safe display name for an uploaded file (no paths, no control characters, ≤ 200 characters). */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = Array.from(base)
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f && !'"<>|*?:'.includes(char))
    .join('')
    .trim();
  return (cleaned === '' ? 'file' : cleaned).slice(0, 200);
}
