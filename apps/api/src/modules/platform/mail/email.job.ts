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
] as const;

export const emailPayloadSchema = z.object({
  template: z.enum(TEMPLATES),
  to: z.email(),
  /** The variables, sealed with the identity key (they contain one-time links). */
  sealed: z.string().min(1),
});

const sealContext = (tenantId: string, to: string) => `email:${tenantId}:${to}`;

/**
 * Queues an email in the caller's tenant transaction. The links inside never reach the database in
 * clear text: the outbox row and the job carry them sealed (AES-256-GCM, bound to school + recipient).
 */
export async function queueEmail(
  tx: TenantTx,
  box: SecretBox,
  message: { template: EmailTemplate; to: string; vars: EmailVariables },
): Promise<void> {
  const tenantId = requireTenantId();
  await addToOutbox(tx, EMAIL_SEND_JOB, {
    template: message.template,
    to: message.to,
    sealed: box.sealText(JSON.stringify(message.vars), sealContext(tenantId, message.to)),
  });
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
      from: `"${vars.schoolName.replace(/["\\\r\n]/g, '')}" <${from}>`,
      to: payload.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    })) as { messageId: string };
    // Never log the recipient's link; the template name and message id are enough to trace delivery.
    logger.info({ job: envelope.type, template: payload.template, messageId: info.messageId }, 'Email sent');
    return { messageId: info.messageId };
  };
}
