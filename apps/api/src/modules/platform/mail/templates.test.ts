import { describe, expect, it } from 'vitest';

import { type EmailTemplate, renderEmail } from './templates';

const TEMPLATES: EmailTemplate[] = [
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
];

describe('school-branded email (F48, UX-15)', () => {
  it('every template names the school and never the platform or another school', () => {
    for (const template of TEMPLATES) {
      const email = renderEmail(template, {
        schoolName: 'Acme Academy',
        displayName: 'Ada',
        link: 'https://acme.example/x',
        amount: 'K250.00',
        number: 'ACME-2026-000001',
        courseTitle: 'Statistics',
        meter: 'instructors',
        level: '80',
        status: 'APPROVED',
        detail: 'acme-new.example',
      });
      const all = `${email.subject}\n${email.text}\n${email.html}`;
      expect(all, template).toContain('Acme');
      expect(all, template).not.toMatch(/studyhub/i);
      expect(all, template).not.toContain('Beta');
    }
  });

  it('escapes school-controlled text in the HTML part', () => {
    const email = renderEmail('school-status', {
      schoolName: '<script>alert(1)</script>',
      detail: 'Hello <b>there</b>',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<b>');
  });
});
