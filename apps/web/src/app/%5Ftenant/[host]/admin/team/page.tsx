import { teamResponseSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TeamManager } from '../../../../../components/team-manager';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { apiGet, requireMember } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin.team'))('title') };
}

/** S-AD14 Team & roles. */
export default async function TeamPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const me = await requireMember();
  const t = await getTranslations();
  const team = teamResponseSchema.parse(await (await apiGet('/api/v1/admin/team')).json());
  const isOwner = me.membership.roles.includes('TENANT_OWNER');
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
    </AdminFrame>
  );
}
