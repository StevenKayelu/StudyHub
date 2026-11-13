import {
  adminLocalesSchema,
  adminSettingsSchema,
  configurationViewSchema,
  DOCUMENT_TYPES,
  LEGAL_PAGES,
} from '@studyhub/contracts';
import { Card } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { type ApiField, ApiForm } from '../../../../../components/api-form';
import { ConfigurationEditor } from '../../../../../components/configuration-editor';
import { PaymentSettingsForm } from '../../../../../components/payment-settings-form';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin, formTexts } from '../../../../../lib/admin-api';
import { commerceTexts } from '../../../../../lib/commerce-texts';
import { fetchContent } from '../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

const POLICIES = ['TUTOR_CHOOSES', 'ALWAYS', 'NEVER'] as const;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.settings'))('title') };
}

/**
 * S-AD09 Settings (F41): one form per group, each change with a reason (one audit entry per changed
 * key, F41 AC 2). Content settings are defaults for new content (BR-64); upload sizes are capped by the
 * plan. Languages (BR-61): only English ships.
 */
export default async function AdminSettingsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const s = (key: string, values?: Record<string, string | number>) =>
    t(`schoolAdmin.settings.${key}`, values);
  const format = await getFormatter();
  const locale = await getLocale();
  const terms = await getTerms(tenant, locale);
  const [settings, locales, configuration] = await Promise.all([
    fetchContent('/api/v1/admin/settings', adminSettingsSchema),
    fetchAdmin('/api/v1/admin/locales', adminLocalesSchema),
    fetchAdmin('/api/v1/admin/configuration', configurationViewSchema),
  ]);
  if (settings === null) return null;
  const texts = await formTexts();
  const uploadTypeNames = t.raw('schoolAdmin.settings.uploadTypeNames') as {
    type: string;
    label: string;
  }[];
  const last = settings.lastChange;
  const { general, content, planCaps } = settings;
  const reason: ApiField = { kind: 'textarea', name: 'reason', label: s('reason'), rows: 2, required: true };
  const options = (key: string) =>
    Object.entries(t.raw(`schoolAdmin.settings.${key}`) as Record<string, string>).map(([value, label]) => ({
      value,
      label,
    }));

  const group = (key: string, fields: ApiField[], extra?: ReactNode, method: 'PATCH' | 'PUT' = 'PATCH') => {
    const name = s(`groups.${key}`);
    return (
      <Card key={key}>
        <h2 className="text-h3">{name}</h2>
        {extra}
        <div className="mt-3">
          <ApiForm
            method={method}
            path={key === 'languages' ? '/api/v1/admin/locales' : '/api/v1/admin/settings'}
            fields={[...fields, reason]}
            submitLabel={s('save', { group: name.toLowerCase() })}
            successMessage={s('saved')}
            keepValues
            texts={texts}
            testId={`settings-${key}`}
          />
        </div>
      </Card>
    );
  };

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/settings"
      title={t('commerce.admin.settings.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/settings', label: t('commerce.admin.settings.title') },
      ]}
    >
      {last !== null ? (
        <Card>
          <p className="text-body-sm text-muted">
            {t('commerce.admin.settings.lastChange', {
              time: format.dateTime(new Date(last.at), { dateStyle: 'medium', timeStyle: 'short' }),
              name: last.by ?? '—',
              reason: last.reason ?? '',
            })}
          </p>
        </Card>
      ) : null}
      {group('learners', [
        {
          kind: 'select',
          name: 'learnerRegistrationMode',
          label: s('registrationMode'),
          options: options('registrationModes'),
          defaultValue: general.learnerRegistrationMode,
        },
        {
          kind: 'list',
          name: 'allowedEmailDomains',
          label: s('allowedDomains'),
          defaultValue: general.allowedEmailDomains,
        },
        {
          kind: 'checkbox',
          name: 'unverifiedFreeEnrolment',
          label: s('unverifiedFree'),
          defaultValue: general.unverifiedFreeEnrolment,
        },
        {
          kind: 'checkbox',
          name: 'singleDeviceLearners',
          label: s('singleDevice'),
          hint: s('singleDeviceHint'),
          defaultValue: general.singleDeviceLearners,
        },
      ])}
      {configuration !== null && configuration !== 'denied' ? (
        <ConfigurationEditor initial={configuration} />
      ) : null}
      {group('instructors', [
        {
          kind: 'select',
          name: 'instructorOnboardingMode',
          label: t('schoolAdmin.settings.onboardingMode', terms),
          options: options('onboardingModes'),
          defaultValue: content.instructorOnboardingMode,
        },
      ])}
      {group(
        'content',
        [
          {
            kind: 'multi',
            name: 'allowedUploadTypes',
            label: s('uploadTypes'),
            options: DOCUMENT_TYPES.map((type) => ({
              value: type,
              label: uploadTypeNames.find((name) => name.type === type)?.label ?? type,
            })),
            defaultValue: content.allowedUploadTypes,
          },
          {
            kind: 'number',
            name: 'maxDocumentMb',
            label: s('maxDocumentMb', { max: planCaps.maxDocumentMb }),
            defaultValue: content.maxDocumentMb,
          },
          {
            kind: 'number',
            name: 'maxVideoGb',
            label: s('maxVideoGb', { max: planCaps.maxVideoGb }),
            defaultValue: content.maxVideoGb,
          },
          {
            kind: 'number',
            name: 'videoCompletionThresholdPct',
            label: s('videoThreshold'),
            defaultValue: content.videoCompletionThresholdPct,
          },
          // Content protection and downloads (docs/design/content-protection.md).
          {
            kind: 'select',
            name: 'contentProtection',
            label: s('contentProtection'),
            options: POLICIES.map((value) => ({
              value,
              label: t(`schoolAdmin.settings.contentProtections.${value}`, terms),
            })),
            defaultValue: content.contentProtection,
          },
          {
            kind: 'select',
            name: 'downloadPolicy',
            label: s('downloadPolicy'),
            options: POLICIES.map((value) => ({
              value,
              label: t(`schoolAdmin.settings.downloadPolicies.${value}`, terms),
            })),
            defaultValue: content.downloadPolicy,
          },
          {
            kind: 'checkbox',
            name: 'downloadsAllowedDefault',
            label: s('downloadsDefault', terms),
            defaultValue: content.downloadsAllowedDefault,
          },
          {
            kind: 'number',
            name: 'defaultAccessDays',
            label: s('accessDays'),
            defaultValue: content.defaultAccessDays,
            emptyAs: 'null',
          },
          {
            kind: 'select',
            name: 'quizDefaults.feedbackPolicy',
            label: `${s('quizDefaults')}: ${s('feedbackPolicy')}`,
            options: options('feedbackPolicies'),
            defaultValue: content.quizDefaults.feedbackPolicy,
          },
          {
            kind: 'number',
            name: 'quizDefaults.attemptsAllowed',
            label: s('attempts'),
            defaultValue: content.quizDefaults.attemptsAllowed,
            emptyAs: 'null',
          },
          {
            kind: 'number',
            name: 'quizDefaults.passMarkPercent',
            label: s('passMark'),
            defaultValue: content.quizDefaults.passMarkPercent,
            emptyAs: 'null',
          },
          {
            kind: 'checkbox',
            name: 'quizDefaults.shuffleQuestions',
            label: s('shuffleQuestions'),
            defaultValue: content.quizDefaults.shuffleQuestions,
          },
          {
            kind: 'checkbox',
            name: 'quizDefaults.shuffleOptions',
            label: s('shuffleOptions'),
            defaultValue: content.quizDefaults.shuffleOptions,
          },
          {
            kind: 'number',
            name: 'practiceDefaults.questionsPerSession',
            label: `${s('practice')}: ${s('questionsPerSession')}`,
            defaultValue: content.practiceDefaults.questionsPerSession,
          },
          {
            kind: 'checkbox',
            name: 'practiceDefaults.mistakesModeEnabled',
            label: s('mistakes'),
            defaultValue: content.practiceDefaults.mistakesModeEnabled,
          },
        ],
        <p className="mt-1 max-w-reading text-body-sm text-muted">{s('contentNote')}</p>,
      )}
      {locales !== null && locales !== 'denied'
        ? group(
            'languages',
            [
              {
                kind: 'select',
                name: 'defaultLocale',
                label: s('defaultLocale'),
                options: locales.available.map((code) => ({ value: code, label: s(`localeNames.${code}`) })),
                defaultValue: locales.defaultLocale,
              },
              {
                kind: 'multi',
                name: 'enabledLocales',
                label: s('enabledLocales'),
                options: locales.available.map((code) => ({ value: code, label: s(`localeNames.${code}`) })),
                defaultValue: locales.enabledLocales,
              },
              {
                kind: 'text',
                name: 'timeZone',
                label: s('timeZone'),
                defaultValue: locales.timeZone,
                required: true,
              },
            ],
            <p className="mt-1 text-body-sm text-muted">
              {s('moreLanguages')} {s('currency')}: {settings.currency}
            </p>,
            'PUT',
          )
        : null}
      {group(
        'legal',
        LEGAL_PAGES.map((page) => ({
          kind: 'textarea' as const,
          name: `legalPages.${page}.${tenant.locales.defaultLocale}`,
          label: s(`legalNames.${page}`),
          rows: 8,
          defaultValue: general.legalPages[page]?.[tenant.locales.defaultLocale] ?? null,
        })),
        <p className="mt-1 text-body-sm text-muted">{s('legalHint')}</p>,
      )}
      <PaymentSettingsForm initial={settings} texts={await commerceTexts(terms)} />
    </AdminFrame>
  );
}
