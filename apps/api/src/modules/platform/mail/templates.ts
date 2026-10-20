/**
 * Transactional email templates (English only at launch; BR-61 adds catalogs per locale). Every email
 * carries the school's name: emails are sent "from" the school (04 §17.11). Plain text first; the HTML
 * part is the same content with links, with no remote images or tracking.
 */
export type EmailTemplate =
  | 'verify-email'
  | 'account-exists'
  | 'reset-password'
  | 'password-changed'
  | 'invitation'
  // Commerce (M8)
  | 'receipt'
  | 'refund-learner'
  | 'refund-instructor'
  | 'payout-recorded'
  | 'ledger-mismatch'
  // Deposit plans (docs/design/payment-plans.md)
  | 'balance-reminder'
  // Tenant administration and console (M9)
  | 'usage-alert'
  | 'school-status'
  | 'support-request'
  | 'domain-decision'
  | 'export-ready'
  | 'statement-issued';

export interface EmailVariables {
  schoolName: string;
  displayName?: string;
  /** A one-time link; sealed in the queue, never logged. */
  link?: string;
  roleLabel?: string;
  /** Commerce (M8): what the email is about, already formatted ("K250.00", "ACME-2026-000123"). */
  courseTitle?: string;
  amount?: string;
  number?: string;
  reference?: string;
  /** Deposit plans: which part was paid ('DEPOSIT', 'BALANCE') and the balance deadline (formatted). */
  part?: string;
  dueDate?: string;
  /** M9: limit alerts, lifecycle and support emails (plain words, already formatted). */
  meter?: string;
  level?: string;
  status?: string;
  reason?: string;
  detail?: string;
  /** F48: the school's support address, used as Reply-To. */
  replyTo?: string;
  /** F48: the school's own sender display name, when it set one. */
  fromName?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function render(
  subject: string,
  paragraphs: string[],
  link?: { label: string; href: string },
): RenderedEmail {
  const text = [...paragraphs, ...(link ? [`${link.label}: ${link.href}`] : [])].join('\n\n');
  const html = [
    '<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1c2126;max-width:560px">',
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(link
      ? [`<p><a href="${escapeHtml(link.href)}" style="color:#a3471c">${escapeHtml(link.label)}</a></p>`]
      : []),
    '</div>',
  ].join('');
  return { subject, text, html };
}

export function renderEmail(template: EmailTemplate, vars: EmailVariables): RenderedEmail {
  const school = vars.schoolName;
  const hello = vars.displayName ? `Hello ${vars.displayName},` : 'Hello,';
  const link = vars.link ?? '';
  switch (template) {
    case 'verify-email':
      return render(
        `Confirm your email for ${school}`,
        [
          hello,
          `Confirm your email address to finish creating your ${school} account. The link works for 24 hours.`,
          "If you didn't create an account, you can ignore this email.",
        ],
        { label: 'Confirm my email', href: link },
      );
    case 'account-exists':
      return render(
        `Sign in to ${school}`,
        [
          hello,
          `Someone tried to create an account at ${school} with this email address. You already have an account, so you can sign in with your existing password and join ${school}.`,
          "If this wasn't you, you can ignore this email. Your account hasn't changed.",
        ],
        { label: `Sign in to ${school}`, href: link },
      );
    case 'reset-password':
      return render(
        `Reset your password`,
        [
          hello,
          `We received a request to reset your password at ${school}. The link works for 1 hour and can be used once.`,
          "If you didn't ask for this, you can ignore this email. Your password hasn't changed.",
        ],
        { label: 'Choose a new password', href: link },
      );
    case 'password-changed':
      return render(`Your password was changed`, [
        hello,
        `The password for your account was changed from ${school}. You have been signed out on your other devices and at your other schools.`,
        "If this wasn't you, reset your password now and contact the school's support.",
      ]);
    case 'invitation':
      return render(
        `You're invited to ${school}`,
        [
          hello,
          `You have been invited to join ${school} as ${vars.roleLabel ?? 'a member'}. The invitation works for 7 days.`,
        ],
        { label: 'Accept the invitation', href: link },
      );
    case 'receipt':
      return render(
        `Your receipt ${vars.number ?? ''} from ${school}`.replace('  ', ' '),
        [
          hello,
          vars.part === 'DEPOSIT'
            ? `Thank you. Your deposit of ${vars.amount ?? ''} for "${vars.courseTitle ?? 'your course'}" is confirmed. The first part of the course is now in My learning; pay the balance by ${vars.dueDate ?? 'the date shown on the course'} to open the rest.`
            : vars.part === 'BALANCE'
              ? `Thank you. Your balance of ${vars.amount ?? ''} for "${vars.courseTitle ?? 'your course'}" is confirmed, and the whole course is now open.`
              : `Thank you. Your payment of ${vars.amount ?? ''} for "${vars.courseTitle ?? 'your course'}" is confirmed and the course is now in My learning.`,
          `Receipt number: ${vars.number ?? ''}. ${school} is the seller.`,
        ],
        { label: 'View your receipt', href: link },
      );
    case 'balance-reminder':
      return render(
        `${school}: your balance for "${vars.courseTitle ?? 'your course'}" is due ${vars.dueDate ?? 'soon'}`,
        [
          hello,
          `Your deposit opened the first part of "${vars.courseTitle ?? 'your course'}". Pay the balance of ${vars.amount ?? ''} by ${vars.dueDate ?? 'the due date'} to open the rest of the course.`,
          'You keep the lessons your deposit opened either way.',
        ],
        { label: 'Pay the balance', href: link },
      );
    case 'refund-learner':
      return render(`Your refund from ${school}`, [
        hello,
        vars.part === 'BALANCE'
          ? `${school} has refunded your balance of ${vars.amount ?? ''} for "${vars.courseTitle ?? 'your course'}". The lessons your deposit opened stay open; pay the balance again to open the rest.`
          : `${school} has refunded ${vars.amount ?? 'your payment'} for "${vars.courseTitle ?? 'your course'}". Your access to the course has ended.`,
        ...(vars.reference ? [`Refund reference: ${vars.reference}.`] : []),
        'Mobile money and card refunds can take a few days to reach you.',
      ]);
    case 'refund-instructor':
      return render(`A sale of "${vars.courseTitle ?? 'your course'}" was refunded`, [
        hello,
        `${school} refunded a sale of "${vars.courseTitle ?? 'your course'}". The earnings from that sale (${vars.amount ?? ''}) have been reversed in your statement.`,
      ]);
    case 'payout-recorded':
      return render(
        `${school} recorded a payout to you`,
        [
          hello,
          `${school} recorded a payout of ${vars.amount ?? ''} to you (reference ${vars.reference ?? '—'}). Check that it reached your account.`,
        ],
        { label: 'See your earnings', href: link },
      );
    case 'ledger-mismatch':
      return render(
        `Action needed: earnings check found a difference at ${school}`,
        [
          hello,
          `The daily check of instructor earnings at ${school} found entries that don't match sales and refunds. Payouts should wait until it is resolved.`,
          vars.reference ?? '',
        ].filter((p) => p !== ''),
        { label: 'Open orders and payments', href: link },
      );
    case 'usage-alert':
      return render(
        `${school} has used ${vars.level ?? ''}% of its ${vars.meter ?? 'plan'} limit`,
        [
          hello,
          vars.level === '100'
            ? `${school} has reached its plan limit for ${vars.meter ?? 'this item'}. New ${vars.meter ?? 'items'} can't be added until usage goes down or the plan changes.`
            : `${school} has used ${vars.level ?? '80'}% of its plan limit for ${vars.meter ?? 'this item'}.`,
          'Contact the platform team if you need a larger plan.',
        ],
        link === '' ? undefined : { label: 'See usage and plan', href: link },
      );
    case 'school-status':
      return render(
        `${school}: ${vars.status ?? 'status changed'}`,
        [
          hello,
          vars.detail ?? `The status of ${school} has changed.`,
          ...(vars.reason ? [`Reason: ${vars.reason}`] : []),
        ],
        link === '' ? undefined : { label: `Open ${school}`, href: link },
      );
    case 'support-request':
      return render(
        vars.status === 'EMERGENCY'
          ? `Emergency support access to ${school} has started`
          : `Platform support asks for access to ${school}`,
        [
          hello,
          vars.status === 'EMERGENCY'
            ? `The platform owner opened emergency support access to ${school}. Every action is recorded in your audit log, and you can revoke the access at any time.`
            : `The platform support team asks for temporary access to ${school}. Nothing is shared until an owner or administrator approves it.`,
          ...(vars.reason ? [`Reason given: ${vars.reason}`] : []),
        ],
        link === '' ? undefined : { label: 'Review support access', href: link },
      );
    case 'domain-decision':
      return render(
        `Your address change for ${school} was ${vars.status === 'APPROVED' ? 'approved' : 'not approved'}`,
        [
          hello,
          vars.status === 'APPROVED'
            ? `${school} now lives at ${vars.detail ?? 'its new address'}. The old address redirects there for 90 days.`
            : `The platform team did not approve the requested address for ${school}.`,
          ...(vars.reason ? [`Note: ${vars.reason}`] : []),
        ],
        link === '' ? undefined : { label: 'Open the Domain page', href: link },
      );
    case 'export-ready':
      return render(
        `Your ${school} export is ready`,
        [hello, `The export you requested at ${school} is ready. The download link works for 7 days.`],
        link === '' ? undefined : { label: 'Open exports', href: link },
      );
    case 'statement-issued':
      return render(
        `New platform statement for ${school}: ${vars.number ?? ''}`.trim(),
        [
          hello,
          `A platform statement for ${vars.number ?? 'last month'} is available. Total due: ${vars.amount ?? ''}.`,
        ],
        link === '' ? undefined : { label: 'Open Billing', href: link },
      );
  }
}
