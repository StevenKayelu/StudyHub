import {
  type ConfigurationImportPreview,
  type ManagedContentKey,
  type ManagedContentValues,
  managedContentValuesSchema,
} from '@studyhub/contracts';

const KEYS: Record<string, ManagedContentKey> = {
  SCHOOL_CATALOG_VISIBILITY: 'catalogVisibility',
  SCHOOL_COURSE_REVIEW_REQUIRED: 'courseReviewRequired',
  SCHOOL_DOWNLOADS_ALLOWED_DEFAULT: 'downloadsAllowedDefault',
};

/** Error messages contain line numbers/key names only, never any uploaded values. */
export class ConfigurationImportError extends Error {}

/** A small data grammar: no evaluation, expansion, subprocesses, file writes or retained raw text. */
export function previewConfigurationImport(text: string): ConfigurationImportPreview {
  if (Buffer.byteLength(text, 'utf8') > 32_768 || text.includes('\0')) {
    throw new ConfigurationImportError('Use a text file smaller than 32 KB without null characters.');
  }
  const values: ManagedContentValues = {};
  const entries: ConfigurationImportPreview['entries'] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) throw new ConfigurationImportError(`Line ${index + 1}: expected KEY=value.`);
    const key = match[1]!;
    const setting = KEYS[key];
    if (setting === undefined) {
      throw new ConfigurationImportError(
        `Line ${index + 1}: ${key} is not dashboard-managed by this importer. Bootstrap keys stay in deployment configuration; credential imports are not supported in this phase.`,
      );
    }
    if (seen.has(key)) throw new ConfigurationImportError(`Line ${index + 1}: duplicate key ${key}.`);
    seen.add(key);
    let value = match[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = /^(["'])([^\r\n]*?)\1\s*(?:#.*)?$/.exec(value);
      if (quoted === null) throw new ConfigurationImportError(`Line ${index + 1}: invalid quoted value.`);
      value = quoted[2]!;
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    const typed =
      setting === 'catalogVisibility' ? value : value === 'true' ? true : value === 'false' ? false : value;
    const parsed = managedContentValuesSchema.safeParse({ [setting]: typed });
    if (!parsed.success) {
      throw new ConfigurationImportError(
        `Line ${index + 1}: invalid value for ${key}. Use PUBLIC/MEMBERS_ONLY or true/false as appropriate.`,
      );
    }
    Object.assign(values, parsed.data);
    entries.push({ key, setting, displayValue: String(typed) });
  }
  if (entries.length === 0) throw new ConfigurationImportError('The file contains no supported settings.');
  return { schemaVersion: 1, values, entries };
}
