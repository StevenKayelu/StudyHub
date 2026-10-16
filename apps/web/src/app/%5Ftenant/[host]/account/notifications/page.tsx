import { notificationListSchema, notificationPreferencesSchema } from '@studyhub/contracts';
import { Card, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { ApiForm } from '../../../../../components/api-form';
import { LearnFrame } from '../../../../../components/learn-frame';
import { actionTexts, formTexts } from '../../../../../lib/admin-api';
import { apiGet } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.notifications'))('title') };
}

/** F33 Notification centre: in-app notifications and the email preferences for non-essential mail. */
export default async function NotificationsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const [list, preferences] = await Promise.all([
    apiGet('/api/v1/me/notifications').then(async (r) => notificationListSchema.parse(await r.json())),
    apiGet('/api/v1/me/notification-preferences').then(async (r) =>
      notificationPreferencesSchema.parse(await r.json()),
    ),
  ]);

  return (
    <LearnFrame tenant={tenant} current="account">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-h1">{t('schoolAdmin.notifications.title')}</h1>
          {list.unread > 0 ? (
            <ActionButton
              label={t('schoolAdmin.notifications.markAll')}
              method="POST"
              path="/api/v1/me/notifications/read"
              body={{ all: true }}
              texts={await actionTexts()}
              testId="mark-all-read"
            />
          ) : null}
        </div>
        {list.items.length === 0 ? (
          <StatePanel kind="empty" title={t('schoolAdmin.notifications.none')} />
        ) : (
          <ul
            className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
            data-testid="notifications"
          >
            {list.items.map((item) => (
              <li
                key={item.id}
                className={`flex flex-col gap-1 p-3 ${item.readAt === null ? 'border-s-4 border-accent' : ''}`}
                data-read={item.readAt !== null}
              >
                {item.link !== null && item.link.startsWith('/') ? (
                  <NextLink href={item.link} className="text-label">
                    {item.title}
                  </NextLink>
                ) : (
                  <span className="text-label">{item.title}</span>
                )}
                {item.body !== null ? <span className="text-body-sm">{item.body}</span> : null}
                <span className="text-caption text-muted">
                  {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Card>
          <h2 className="text-h3">{t('schoolAdmin.notifications.preferences')}</h2>
          <p className="mt-1 text-body-sm text-muted">{t('schoolAdmin.notifications.essential')}</p>
          <div className="mt-3">
            <ApiForm
              method="PUT"
              path="/api/v1/me/notification-preferences"
              fields={[
                {
                  kind: 'checkbox',
                  name: 'learning',
                  label: t('schoolAdmin.notifications.learning'),
                  defaultValue: preferences.learning,
                },
                {
                  kind: 'checkbox',
                  name: 'earnings',
                  label: t('schoolAdmin.notifications.earnings'),
                  defaultValue: preferences.earnings,
                },
              ]}
              submitLabel={t('schoolAdmin.notifications.save')}
              successMessage={t('schoolAdmin.notifications.saved')}
              keepValues
              then="stay"
              texts={await formTexts()}
              testId="notification-preferences"
            />
          </div>
        </Card>
      </div>
    </LearnFrame>
  );
}
