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
  | 'ledger-mismatch';

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
          `Thank you. Your payment of ${vars.amount ?? ''} for "${vars.courseTitle ?? 'your course'}" is confirmed and the course is now in My learning.`,
          `Receipt number: ${vars.number ?? ''}. ${school} is the seller.`,
        ],
        { label: 'View your receipt', href: link },
      );
    case 'refund-learner':
      return render(`Your refund from ${school}`, [
        hello,
        `${school} has refunded ${vars.amount ?? 'your payment'} for "${vars.courseTitle ?? 'your course'}". Your access to the course has ended.`,
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
  }
}
