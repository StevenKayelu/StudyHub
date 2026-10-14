/**
 * Content type from magic bytes (BR-29, F11 AC 1): the declared type of an upload must match what the
 * file actually is. Office formats (DOCX, PPTX, XLSX) are ZIP containers, so they sniff as ZIP; the
 * declared type then decides among those.
 */
export type SniffedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/pdf'
  | 'application/zip'
  | 'video/mp4'
  | 'video/webm';

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((value, index) => bytes[offset + index] === value);

const ascii = (bytes: Buffer, text: string, offset = 0) =>
  startsWith(bytes, [...Buffer.from(text, 'latin1')], offset);

export function sniffType(bytes: Buffer): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 'RIFF') && ascii(bytes, 'WEBP', 8)) return 'image/webp';
  if (ascii(bytes, '%PDF-')) return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (ascii(bytes, 'ftyp', 4)) return 'video/mp4';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  return null;
}

const ZIP_BASED = new Set([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Whether the bytes are consistent with the declared MIME type. */
export function matchesDeclaredType(declared: string, bytes: Buffer): boolean {
  const sniffed = sniffType(bytes);
  if (sniffed === null) return false;
  if (sniffed === 'application/zip') return ZIP_BASED.has(declared);
  if (sniffed === 'video/mp4') return declared === 'video/mp4' || declared === 'video/quicktime';
  return sniffed === declared;
}
