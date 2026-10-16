import { teamResponseSchema } from '@studyhub/contracts';
import { Card } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { TeamManager } from '../../../../../components/team-manager';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { actionTexts } from '../../../../../lib/admin-api';
import { apiGet, requireMember } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin.team'))('title') };
}

/** S-AD14 Team & roles; owners can invite an administrator to become an owner (F42). */
export default async function TeamPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const me = await requireMember();
  const t = await getTranslations();
  const team = teamResponseSchema.parse(await (await apiGet('/api/v1/admin/team')).json());
  const isOwner = me.membership.roles.includes('TENANT_OWNER') && me.support === null;
  const ownerCandidates = isOwner
    ? team.members.filter((m) => m.roles.includes('TENANT_ADMIN') && !m.roles.includes('TENANT_OWNER'))
    : [];
  const texts = await actionTexts();
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/team"
      title={t('admin.team.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/team', label: t('admin.team.title') },
      ]}
    >
      <TeamManager
        team={team}
        selfMembershipId={me.membership.id}
        manageableRoles={
          isOwner ? ['LEARNER', 'INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER'] : ['LEARNER', 'INSTRUCTOR']
        }
        texts={{
          errorSummary: t('common.errorSummary'),
          networkError: t('common.networkError'),
          members: t('admin.team.members'),
          invitations: t('admin.team.invitations'),
          invite: t('admin.team.invite'),
          email: t('common.email'),
          role: t('admin.team.role'),
          inviteSubmit: t('admin.team.inviteSubmit'),
          inviteSubmitting: t('admin.team.inviteSubmitting'),
          invited: t.raw('admin.team.invited') as string,
          revoke: t('admin.team.revoke'),
          remove: t('admin.team.remove'),
          removeConfirm: t.raw('admin.team.removeConfirm') as string,
          changeRoles: t('admin.team.changeRoles'),
          saveRoles: t('admin.team.saveRoles'),
          expires: t.raw('admin.team.expires') as string,
          none: t('admin.team.none'),
          close: t('common.close'),
          cancel: t('common.cancel'),
          roleNames: t.raw('auth.roleNames') as Record<string, string>,
        }}
      />
      {ownerCandidates.length > 0 ? (
        <Card>
          <h2 className="text-h3">{t('schoolAdmin.team.makeOwner')}</h2>
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {ownerCandidates.map((member) => (
              <li
                key={member.membershipId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="text-label">{member.displayName}</span>
                <ActionButton
                  label={t('schoolAdmin.team.makeOwner')}
                  method="POST"
                  path="/api/v1/admin/owners/transfer"
                  body={{ membershipId: member.membershipId }}
                  texts={texts}
                  doneLabel={t('schoolAdmin.team.makeOwnerSent')}
                  testId="make-owner"
                  confirm={{
                    title: t('schoolAdmin.team.makeOwnerTitle', { name: member.displayName }),
                    description: t('schoolAdmin.team.makeOwnerBody'),
                    confirmLabel: t('schoolAdmin.team.makeOwner'),
                  }}
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </AdminFrame>
  );
}
