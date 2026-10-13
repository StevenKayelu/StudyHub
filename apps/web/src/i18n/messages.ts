import en from '../../messages/en.json';

export type Messages = typeof en;

/** Shipped catalogs (SUPPORTED_LOCALES in @studyhub/contracts). Only English at launch. */
const catalogs: Record<string, () => Promise<unknown>> = {
  en: () => Promise.resolve(en),
};

type Tree = { [key: string]: string | Tree };

/** `base` with every key that `override` defines replaced; missing keys keep the base text. */
export function mergeMessages(base: Tree, override: Tree): Tree {
  const result: Tree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] =
      typeof value === 'object' && typeof current === 'object' ? mergeMessages(current, value) : value;
  }
  return result;
}

/**
 * The catalog for `locale`, with any key it lacks taken from the school's default locale and then
 * from English, so a partially translated catalog never shows raw message keys.
 */
export async function loadMessages(locale: string, defaultLocale: string): Promise<Messages> {
  const load = async (code: string): Promise<Tree> => ((await catalogs[code]?.()) ?? {}) as Tree;
  let messages = en as unknown as Tree;
  if (defaultLocale !== 'en') messages = mergeMessages(messages, await load(defaultLocale));
  if (locale !== defaultLocale && locale !== 'en') messages = mergeMessages(messages, await load(locale));
  return messages as unknown as Messages;
}
