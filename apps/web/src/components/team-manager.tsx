'use client';

import type { TeamResponse } from '@studyhub/contracts';
import { Alert, Button, Card, Checkbox, Dialog, Select, StatusBadge, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { callApi } from '../lib/client-api';
import { type FormTexts, text, useApiForm } from './forms';

const ROLES = ['LEARNER', 'INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER'] as const;

export interface TeamTexts extends FormTexts {
  members: string;
  invitations: string;
  invite: string;
  email: string;
  role: string;
  inviteSubmit: string;
  inviteSubmitting: string;
  invited: string;
  revoke: string;
  remove: string;
  removeConfirm: string;
  changeRoles: string;
  saveRoles: string;
  expires: string;
  none: string;
  close: string;
  cancel: string;
  roleNames: Record<string, string>;
}

/** Team & roles (S-AD14): members, pending invitations, invite, roles, remove. */
export function TeamManager({
  team,
  texts,
  manageableRoles,
  selfMembershipId,
}: {
  team: TeamResponse;
  texts: TeamTexts;
  /** Roles this administrator may grant (owners: all; admins: learner and instructor). */
  manageableRoles: string[];
  selfMembershipId: string;
}) {
  const router = useRouter();
  const invite = useApiForm(texts);
  const [invitedTo, setInvitedTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => router.refresh();
  const roleName = (role: string) => texts.roleNames[role] ?? role;
  const canManage = (roles: string[]) => roles.every((role) => manageableRoles.includes(role));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="text-h3">{texts.invite}</h2>
        <form
          className="mt-3 grid gap-4 md:grid-cols-[1fr_14rem_auto] md:items-end"
          noValidate
          onSubmit={async (event) => {
            const email = text(new FormData(event.currentTarget), 'email');
            const target = event.currentTarget;
            const result = await invite.submit(event, (data) =>
              callApi('POST', '/api/v1/admin/invitations', {
                email: text(data, 'email'),
                role: text(data, 'role'),
              }),
            );
            if (result !== null) {
              setInvitedTo(email);
              target.reset();
              refresh();
            }
          }}
        >
          <div className="md:col-span-3">{invite.feedback}</div>
          {invitedTo !== null ? (
            <div className="md:col-span-3">
              <Alert tone="success" role="status" title={texts.invited.replace('{email}', invitedTo)} />
            </div>
          ) : null}
          <TextField
            id="email"
            name="email"
            type="email"
            label={texts.email}
            error={invite.fieldError('email')}
            required
          />
          <Select
            id="role"
            name="role"
            label={texts.role}
            defaultValue="INSTRUCTOR"
            options={ROLES.filter((role) => manageableRoles.includes(role)).map((role) => ({
              value: role,
              label: roleName(role),
            }))}
          />
          <Button type="submit" variant="primary" loading={invite.busy} loadingLabel={texts.inviteSubmitting}>
            {texts.inviteSubmit}
          </Button>
        </form>
      </Card>

      {problem !== null ? <Alert tone="danger" role="alert" title={problem} /> : null}

      <Card>
        <h2 className="text-h3">{texts.members}</h2>
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {team.members.map((member) => (
            <li key={member.membershipId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-label">{member.displayName}</p>
                <p className="text-body-sm break-all text-muted">{member.email}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {member.roles.map((role) => (
                    <StatusBadge key={role} status={role === 'TENANT_OWNER' ? 'published' : 'draft'}>
                      {roleName(role)}
                    </StatusBadge>
                  ))}
                </div>
              </div>
              {canManage(member.roles) ? (
                <div className="flex gap-2">
                  <RolesDialog
                    member={member}
                    texts={texts}
                    manageableRoles={manageableRoles}
                    onSaved={refresh}
                    onProblem={setProblem}
                  />
                  {member.membershipId === selfMembershipId ? null : (
                    <Dialog
                      title={texts.remove}
                      description={texts.removeConfirm.replace('{name}', member.displayName)}
                      closeLabel={texts.close}
                      trigger={
                        <Button size="sm" variant="ghost">
                          {texts.remove}
                        </Button>
                      }
                      footer={
                        <Button
                          variant="danger"
                          onClick={async () => {
                            const result = await callApi(
                              'DELETE',
                              `/api/v1/admin/members/${member.membershipId}`,
                            );
                            if (!result.ok) setProblem(result.problem.title);
                            refresh();
                          }}
                        >
                          {texts.remove}
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="text-h3">{texts.invitations}</h2>
        {team.invitations.length === 0 ? (
          <p className="mt-2 text-body text-muted">{texts.none}</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {team.invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-body break-all">{invitation.email}</p>
                  <p className="text-body-sm text-muted">
                    {roleName(invitation.role)} ·{' '}
                    {texts.expires.replace('{date}', new Date(invitation.expiresAt).toLocaleDateString())}
                  </p>
                </div>
                {manageableRoles.includes(invitation.role) ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await callApi('DELETE', `/api/v1/admin/invitations/${invitation.id}`);
                      refresh();
                    }}
                  >
                    {texts.revoke}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RolesDialog({
  member,
  texts,
  manageableRoles,
  onSaved,
  onProblem,
}: {
  member: TeamResponse['members'][number];
  texts: TeamTexts;
  manageableRoles: string[];
  onSaved: () => void;
  onProblem: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<string[]>(member.roles);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={`${texts.changeRoles}: ${member.displayName}`}
      closeLabel={texts.close}
      trigger={
        <Button size="sm" variant="secondary">
          {texts.changeRoles}
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {texts.cancel}
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              const result = await callApi('PUT', `/api/v1/admin/members/${member.membershipId}/roles`, {
                roles,
              });
              onProblem(result.ok ? null : result.problem.title);
              setOpen(false);
              onSaved();
            }}
          >
            {texts.saveRoles}
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        {ROLES.map((role) => (
          <Checkbox
            key={role}
            label={texts.roleNames[role] ?? role}
            checked={roles.includes(role)}
            disabled={!manageableRoles.includes(role)}
            onCheckedChange={(checked) =>
              setRoles((current) => (checked ? [...current, role] : current.filter((r) => r !== role)))
            }
          />
        ))}
      </div>
    </Dialog>
  );
}
