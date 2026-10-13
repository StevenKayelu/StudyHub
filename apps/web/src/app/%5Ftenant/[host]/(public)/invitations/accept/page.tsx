import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { InvitationAccept } from '../../../../../../components/auth-forms';
import { AuthPage } from '../../../../../../components/auth-page';
import { currentTenant } from '../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.invitation'))('submit') };
}

/** Accept an invitation (BR-67): existing account signs in; a new person creates one. */
export default async function AcceptInvitationPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const roles = t.raw('auth.roles') as Record<string, string>;
  return (
    <AuthPage tenant={tenant}>
      <InvitationAccept
        texts={{
          errorSummary: t('common.errorSummary'),
          networkError: t('common.networkError'),
          title: t.raw('auth.invitation.title') as string,
          body: t.raw('auth.invitation.body') as string,
          existing: t('auth.invitation.existing'),
          newAccount: t('auth.invitation.newAccount'),
          name: t('common.name'),
          password: t('common.password'),
          passwordHint: t('auth.signUp.passwordHint'),
          submit: t('auth.invitation.submit'),
          submitting: t('auth.invitation.submitting'),
          invalid: t('auth.invitation.invalid'),
          roles,
        }}
      />
    </AuthPage>
  );
}
