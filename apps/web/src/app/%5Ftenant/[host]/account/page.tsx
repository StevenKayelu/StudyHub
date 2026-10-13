import { mySchoolsResponseSchema, sessionListSchema } from '@studyhub/contracts';
import { Card, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import {
  ChangePasswordForm,
  ResendVerification,
  SchoolSwitcher,
  SessionsPanel,
} from '../../../../components/account-panels';
import { LearnFrame } from '../../../../components/learn-frame';
import { SignOutButton } from '../../../../components/sign-out-button';
import { apiGet, requireMember } from '../../../../lib/session';
import { currentTenant } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('account'))('title') };
}

/** A short device description from a user-agent string (no fingerprinting, display only). */
function describeDevice(userAgent: string | null, unknown: string): string {
  if (userAgent === null) return unknown;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' · ') || unknown;
}

/** Account (S-L account): profile, schools (switcher), devices, password. */
export default async function AccountPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const me = await requireMember();
  const t = await getTranslations();
  const format = await getFormatter();
  const [schools, sessions] = await Promise.all([
    apiGet('/api/v1/me/schools').then(async (r) => mySchoolsResponseSchema.parse(await r.json())),
    apiGet('/api/v1/me/sessions').then(async (r) => sessionListSchema.parse(await r.json())),
  ]);
  const common = { errorSummary: t('common.errorSummary'), networkError: t('common.networkError') };
  const roleNames = t.raw('auth.roleNames') as Record<string, string>;

  return (
    <LearnFrame tenant={tenant} current="account">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-h1">{t('account.title')}</h1>
          <SignOutButton label={t('common.signOut')} />
        </div>
        <Card>
          <h2 className="text-h3">{t('account.profile')}</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 md:grid-cols-[auto_1fr]">
            <dt className="text-label text-muted">{t('common.name')}</dt>
            <dd className="text-body" data-testid="account-name">
              {me.user.displayName}
            </dd>
            <dt className="text-label text-muted">{t('common.email')}</dt>
            <dd className="flex flex-wrap items-center gap-2 text-body break-all">
              {me.user.email}
              {me.user.emailVerified ? null : (
                <>
                  <StatusBadge status="pending">{t('account.emailUnverified')}</StatusBadge>
                  <ResendVerification label={t('account.resend')} sentLabel={t('account.resent')} />
                </>
              )}
            </dd>
          </dl>
        </Card>
        <SchoolSwitcher
          schools={schools.schools}
          texts={{
            title: t('account.schools'),
            current: t('account.current'),
            switchTo: t.raw('account.switchTo') as string,
            failed: t('auth.switching.failed'),
            roles: roleNames,
          }}
        />
        <SessionsPanel
          sessions={sessions.sessions.map((session) => ({
            id: session.id,
            current: session.current,
            device: describeDevice(session.userAgent, t('account.unknownDevice')),
            lastSeen: t('account.lastSeen', { time: format.relativeTime(new Date(session.lastSeenAt)) }),
          }))}
          texts={{
            title: t('account.sessions'),
            thisDevice: t('account.thisDevice'),
            endSession: t('account.endSession'),
            everywhere: t('account.signOutEverywhere'),
            everywhereHint: t('account.signOutEverywhereHint'),
          }}
        />
        <ChangePasswordForm
          texts={{
            ...common,
            title: t('account.password'),
            current: t('account.currentPassword'),
            next: t('account.newPassword'),
            hint: t('auth.signUp.passwordHint'),
            submit: t('auth.reset.submit'),
            submitting: t('auth.reset.submitting'),
            done: t('account.passwordChanged'),
          }}
        />
      </div>
    </LearnFrame>
  );
}
