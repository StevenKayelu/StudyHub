import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import { z } from 'zod';

import { requireTenantId } from '../context/request-context';
import type { TenantTx } from '../db/tenant-db';
import { addToOutbox } from '../jobs/outbox';
import type { JobEnvelope } from '../jobs/job-envelope';
import type { SecretBox } from '../security/secret-box';
import { type EmailTemplate, type EmailVariables, renderEmail } from './templates';

/** Queue for transactional email; fed by the outbox, so emails are sent only if the change committed. */
export const EMAIL_SEND_JOB = 'email.send';

const TEMPLATES = [
  'verify-email',
  'account-exists',
  'reset-password',
  'password-changed',
  'invitation',
  'receipt',
  'refund-learner',
  'refund-instructor',
  'payout-recorded',
  'ledger-mismatch',
  'balance-reminder',
  'usage-alert',
  'school-status',
  'support-request',
  'domain-decision',
  'export-ready',
  'statement-issued',
] as const;

export const emailPayloadSchema = z.object({
  template: z.enum(TEMPLATES),
  to: z.email(),
  /** The variables, sealed with the identity key (they contain one-time links). */
  sealed: z.string().min(1),
});

const sealContext = (tenantId: string, to: string) => `email:${tenantId}:${to}`;

/**
 * In-app notifications (F33): which emails also appear in a member's notification centre, where they
 * link to, and which preference category (if any) can turn the email off. Security and payment emails
 * can't be turned off; sign-up and invitation emails go to people who may not be members yet.
 */
const NOTIFY: Partial<Record<EmailTemplate, { link: string; category?: 'learning' | 'earnings' }>> = {
  'password-changed': { link: '/account' },
  'signed-in-elsewhere': { link: '/account' },
  receipt: { link: '/account/purchases' },
  'refund-learner': { link: '/account/purchases' },
  'refund-instructor': { link: '/studio/earnings', category: 'earnings' },
  'payout-recorded': { link: '/studio/earnings', category: 'earnings' },
  'ledger-mismatch': { link: '/admin/orders' },
  'usage-alert': { link: '/admin/usage' },
  'school-status': { link: '/admin' },
  'support-request': { link: '/admin/support-access' },
  'domain-decision': { link: '/admin/domain' },
  'export-ready': { link: '/admin/exports' },
  'statement-issued': { link: '/admin/billing' },
  'saas-invoice': { link: '/admin/billing' },
};

/**
 * Queues an email in the caller's tenant transaction. The links inside never reach the database in
 * clear text: the outbox row and the job carry them sealed (AES-256-GCM, bound to school + recipient).
 *
 * M9: emails carry the school's sender name and reply-to (F48); when the recipient is a member of the
 * school, the email also lands in their notification centre, and a member can turn off non-essential
 * categories (F33).
 */
export async function queueEmail(
  tx: TenantTx,
  box: SecretBox,
  message: { template: EmailTemplate; to: string; vars: EmailVariables },
): Promise<void> {
  const tenantId = requireTenantId();
  const branding = await tx.tenantBranding.findFirst({ select: { supportEmail: true, emailFromName: true } });
  const fromName = localizedFromName(branding?.emailFromName);
  const vars: EmailVariables = {
    ...message.vars,
    ...(message.vars.replyTo === undefined && branding?.supportEmail
      ? { replyTo: branding.supportEmail }
      : {}),
    ...(fromName !== null && { fromName }),
  };

  const notify = NOTIFY[message.template];
  let sendEmail = true;
  if (notify !== undefined) {
    const member = await tx.tenantMembership.findFirst({
      where: { user: { email: message.to }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (member !== null) {
      await tx.notification.create({
        data: {
          tenantId,
          membershipId: member.id,
          kind: message.template,
          title: renderEmail(message.template, { ...vars, link: '' }).subject.slice(0, 200),
          link: notify.link,
        },
      });
      if (notify.category !== undefined) {
        const preference = await tx.notificationPreference.findFirst({
          where: { membershipId: member.id, category: notify.category },
          select: { emailEnabled: true },
        });
        sendEmail = preference?.emailEnabled ?? true;
      }
    }
  }
  if (!sendEmail) return;
  await addToOutbox(tx, EMAIL_SEND_JOB, {
    template: message.template,
    to: message.to,
    sealed: box.sealText(JSON.stringify(vars), sealContext(tenantId, message.to)),
  });
}

function localizedFromName(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const first = Object.values(value as Record<string, unknown>).find(
    (text): text is string => typeof text === 'string' && text.trim() !== '',
  );
  return first?.trim().slice(0, 120) ?? null;
}

export function createMailTransport(smtpUrl: string): Transporter {
  return createTransport(smtpUrl);
}

/** Worker handler for `email.send`: opens the sealed variables, renders and sends. */
export function createEmailHandler(box: SecretBox, transport: Transporter, from: string) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<{ messageId: string }> => {
    const payload = emailPayloadSchema.parse(envelope.payload);
    if (envelope.tenantId === null) throw new Error('email.send requires a tenant');
    const vars = JSON.parse(
      box.openText(payload.sealed, sealContext(envelope.tenantId, payload.to)),
    ) as EmailVariables;
    const email = renderEmail(payload.template, vars);
    const info = (await transport.sendMail({
      from: `"${(vars.fromName ?? vars.schoolName).replace(/["\\\r\n]/g, '')}" <${from}>`,
      to: payload.to,
      ...(vars.replyTo !== undefined && { replyTo: vars.replyTo }),
      subject: email.subject,
      text: email.text,
      html: email.html,
    })) as { messageId: string };
    // Never log the recipient's link; the template name and message id are enough to trace delivery.
    logger.info({ job: envelope.type, template: payload.template, messageId: info.messageId }, 'Email sent');
    return { messageId: info.messageId };
  };
}
