import 'server-only';

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import type { ActionTexts } from '../components/action-button';
import type { ApiFormProps } from '../components/api-form';
import type { FormTexts } from '../components/forms';
import { fetchContent } from './content-api';
import { apiGet } from './session';

/** A GET for an admin page that some roles may not see: 403 becomes 'denied' (S-X05 in the page). */
export async function fetchAdmin<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | 'denied' | null> {
  const response = await apiGet(path);
  if (response.status === 403) return 'denied';
  if (response.status === 404) return null;
  if (!response.ok) return fetchContent(path, schema);
  return schema.parse(await response.json());
}

/** Strings for ActionButton (confirmations and console re-authentication). */
export async function actionTexts(): Promise<ActionTexts> {
  const t = await getTranslations();
  return {
    close: t('schoolAdmin.actions.close'),
    cancel: t('schoolAdmin.actions.cancel'),
    networkError: t('common.networkError'),
    reauthTitle: t('schoolAdmin.actions.reauthTitle'),
    reauthBody: t('schoolAdmin.actions.reauthBody'),
    code: t('schoolAdmin.actions.code'),
    verify: t('schoolAdmin.actions.verify'),
  };
}

/** Strings every API form needs (06 §2.7). */
export async function formTexts(): Promise<FormTexts> {
  const t = await getTranslations('common');
  return { errorSummary: t('errorSummary'), networkError: t('networkError') };
}

/** A console GET (server side, `/console/...`): 401 redirects to sign-in, 403 becomes 'denied', 404 null. */
export async function fetchConsole<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | 'denied' | null> {
  const response = await apiGet(`/console${path}`);
  // Layouts and pages render concurrently: the page can get here before the layout's redirect.
  if (response.status === 401) redirect('/sign-in');
  if (response.status === 403) return 'denied';
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The API returned ${response.status} for /console${path}.`);
  return schema.parse(await response.json());
}

/** Strings for an ApiForm's console re-authentication prompt. */
export async function reauthTexts(): Promise<NonNullable<ApiFormProps['reauth']>> {
  const t = await getTranslations('schoolAdmin.actions');
  return {
    title: t('reauthTitle'),
    body: t('reauthBody'),
    code: t('code'),
    verify: t('verify'),
    close: t('close'),
  };
}
