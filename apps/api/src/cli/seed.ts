// `pnpm db:seed`: three demo schools for local development and e2e tests (idempotent).
// Runs as the migrator role. Never run against production.
import { Client } from 'pg';

import { ConfigError, hashPassword, loadMigratorEnv } from '../modules/platform';
import { provisionTenant, type ProvisionTenantInput, writeTenantProfile } from '../modules/tenancy';

/**
 * Acme keeps the Copperline default; Beta has its own accent, font preset and terminology, so the
 * theming runtime and terminology substitution are visible (and tested) side by side. Gamma is still
 * being set up.
 */
export const DEMO_TENANTS: readonly (ProvisionTenantInput & {
  branding: NonNullable<ProvisionTenantInput['branding']>;
})[] = [
  {
    slug: 'acme',
    name: 'Acme Academy',
    kind: 'SCHOOL',
    hostname: 'acme.localhost',
    status: 'ACTIVE',
    branding: { accentHex: null, fontPreset: 'COPPERLINE' },
  },
  {
    slug: 'beta',
    name: 'Beta College',
    kind: 'COLLEGE',
    hostname: 'beta.localhost',
    status: 'ACTIVE',
    branding: {
      accentHex: '#0b7285',
      fontPreset: 'HUMANIST',
      terminology: {
        instructor: { en: 'Lecturer' },
        instructors: { en: 'Lecturers' },
        course: { en: 'Module' },
        courses: { en: 'Modules' },
      },
    },
  },
  {
    // Not live yet: its site shows the "Coming soon" page (S-X08).
    slug: 'gamma',
    name: 'Gamma Tutors',
    kind: 'TUTORING_BUSINESS',
    hostname: 'gamma.localhost',
    status: 'PROVISIONING',
    branding: { accentHex: '#6d28d9', fontPreset: 'GEOMETRIC' },
  },
];

/** The id of an existing school, found the way the runtime finds it (resolve_tenant, as the app role). */
async function existingTenantId(appUrl: string | undefined, hostname: string): Promise<string | undefined> {
  if (appUrl === undefined) return undefined;
  const app = new Client({ connectionString: appUrl, application_name: 'studyhub-seed' });
  await app.connect();
  try {
    const { rows } = await app.query<{ tenant_id: string }>('SELECT tenant_id FROM resolve_tenant($1)', [
      hostname,
    ]);
    return rows[0]?.tenant_id;
  } finally {
    await app.end();
  }
}

/** Runs `fn` as the migrator in one transaction with the given context settings (FORCE RLS applies). */
async function withContext<T>(
  client: Client,
  settings: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    for (const [key, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** DEVELOPMENT ONLY. Shared by every demo account; documented in the README. */
export const DEMO_PASSWORD = 'studyhub-demo-pass';

type DemoRole = 'LEARNER' | 'INSTRUCTOR' | 'TENANT_ADMIN' | 'TENANT_OWNER';

/** Demo people (fixed ids keep the seed idempotent). The learner belongs to two schools (D3). */
export const DEMO_ACCOUNTS: readonly {
  id: string;
  email: string;
  name: string;
  memberships: Partial<Record<'acme' | 'beta', DemoRole[]>>;
}[] = [
  {
    id: '0d6c2b1e-0000-4000-8000-00000000a001',
    email: 'owner@acme.test',
    name: 'Ada Banda',
    memberships: { acme: ['LEARNER', 'TENANT_OWNER'] },
  },
  {
    id: '0d6c2b1e-0000-4000-8000-00000000a002',
    email: 'tutor@acme.test',
    name: 'Tiko Phiri',
    memberships: { acme: ['LEARNER', 'INSTRUCTOR'] },
  },
  {
    id: '0d6c2b1e-0000-4000-8000-00000000b001',
    email: 'owner@beta.test',
    name: 'Bwalya Zulu',
    memberships: { beta: ['LEARNER', 'TENANT_OWNER'] },
  },
  {
    id: '0d6c2b1e-0000-4000-8000-00000000c001',
    email: 'learner@example.test',
    name: 'Chanda Mwila',
    memberships: { acme: ['LEARNER'], beta: ['LEARNER'] },
  },
];

export const DEMO_STAFF = {
  id: '0d6c2b1e-0000-4000-8000-00000000f001',
  email: 'staff@studyhub.test',
  name: 'Platform Owner',
  role: 'PLATFORM_OWNER',
} as const;

async function seedAccounts(
  client: Client,
  tenantIds: Partial<Record<'acme' | 'beta', string>>,
): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const account of DEMO_ACCOUNTS) {
    await withContext(client, { 'app.user_id': account.id }, async () => {
      await client.query(
        `INSERT INTO user_account (id, email, display_name, email_verified_at) VALUES ($1, $2, $3, now())
         ON CONFLICT DO NOTHING`,
        [account.id, account.email, account.name],
      );
      await client.query(
        `INSERT INTO credential (user_id, password_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
        [account.id, passwordHash],
      );
    });
    for (const [school, roles] of Object.entries(account.memberships) as ['acme' | 'beta', DemoRole[]][]) {
      const tenantId = tenantIds[school];
      if (tenantId === undefined) continue;
      await withContext(client, { 'app.tenant_id': tenantId }, async () => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tenant_membership (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'ACTIVE', now())
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = tenant_membership.status RETURNING id`,
          [tenantId, account.id],
        );
        for (const role of roles) {
          await client.query(
            `INSERT INTO membership_role (tenant_id, membership_id, role) VALUES ($1, $2, $3::"TenantRole")
             ON CONFLICT DO NOTHING`,
            [tenantId, rows[0]!.id, role],
          );
        }
      });
    }
  }
  await withContext(client, { 'app.realm': 'platform' }, async () => {
    await client.query(
      `INSERT INTO platform_user (id, email, display_name, role) VALUES ($1, $2, $3, $4::"PlatformRole")
       ON CONFLICT DO NOTHING`,
      [DEMO_STAFF.id, DEMO_STAFF.email, DEMO_STAFF.name, DEMO_STAFF.role],
    );
    await client.query(
      // Re-seeding resets the demo staff member's two-step enrolment (they enrol again at next sign-in).
      `INSERT INTO platform_credential (user_id, password_hash) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
         recovery_codes_hash = '{}'`,
      [DEMO_STAFF.id, passwordHash],
    );
  });
}

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

/** Demo catalogue for Acme: categories, the tutor's approved profile and two published free courses. */
const DEMO_CATALOGUE = {
  categories: [
    {
      id: '0d6c2b1e-0000-4000-8000-0000000ca001',
      slug: 'sciences',
      name: 'Sciences',
      subjects: [
        { id: '0d6c2b1e-0000-4000-8000-0000000cb001', slug: 'biology', name: 'Biology' },
        { id: '0d6c2b1e-0000-4000-8000-0000000cb002', slug: 'chemistry', name: 'Chemistry' },
      ],
    },
    {
      id: '0d6c2b1e-0000-4000-8000-0000000ca002',
      slug: 'mathematics',
      name: 'Mathematics',
      subjects: [{ id: '0d6c2b1e-0000-4000-8000-0000000cb003', slug: 'algebra', name: 'Algebra' }],
    },
  ],
  courses: [
    {
      id: '0d6c2b1e-0000-4000-8000-0000000cc001',
      slug: 'biology-foundations',
      title: 'Biology foundations',
      subtitle: 'Cells, genetics and ecosystems for Grade 10 to 12',
      subjectId: '0d6c2b1e-0000-4000-8000-0000000cb001',
      level: 'BEGINNER',
      tags: ['cells', 'genetics', 'exam prep'],
      outcomes: ['Describe the parts of a cell', 'Explain how traits are inherited', 'Read a food web'],
      description: doc(
        'A clear, exam-focused introduction to biology. Each section starts from everyday examples and ' +
          'builds up to the vocabulary and diagrams examiners expect.',
        'Short readings, worked examples and practice questions help you check your understanding as ' +
          'you go. No previous biology is assumed.',
      ),
      sections: [
        {
          title: 'Cells',
          lessons: ['What is a cell?', 'Plant and animal cells', 'Cell division'],
        },
        { title: 'Genetics', lessons: ['Genes and chromosomes', 'Inheritance'] },
      ],
    },
    {
      id: '0d6c2b1e-0000-4000-8000-0000000cc002',
      slug: 'algebra-essentials',
      title: 'Algebra essentials',
      subtitle: 'Expressions, equations and graphs step by step',
      subjectId: '0d6c2b1e-0000-4000-8000-0000000cb003',
      level: 'ALL_LEVELS',
      tags: ['equations', 'graphs'],
      outcomes: ['Simplify expressions', 'Solve linear equations', 'Plot straight-line graphs'],
      description: doc(
        'Algebra is a language for patterns. This course takes you from simplifying expressions to ' +
          'solving equations and drawing graphs, one small step at a time.',
        'Every lesson ends with a few questions so you know when you are ready to move on.',
      ),
      sections: [{ title: 'Expressions', lessons: ['Like terms', 'Brackets'] }],
    },
  ],
} as const;

async function seedCatalogue(client: Client, tenantId: string): Promise<void> {
  await withContext(client, { 'app.tenant_id': tenantId }, async () => {
    const tutor = DEMO_ACCOUNTS.find((account) => account.email === 'tutor@acme.test')!;
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM tenant_membership WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, tutor.id],
    );
    const membershipId = rows[0]?.id;
    if (membershipId === undefined) return;
    await client.query(
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, headline, bio, subjects, status, decided_at)
       VALUES ($1, $2, 'tiko-phiri', $3, 'Science and maths teacher, 10 years', $4, $5, 'APPROVED', now())
       ON CONFLICT (membership_id) DO NOTHING`,
      [
        membershipId,
        tenantId,
        tutor.name,
        'I teach biology and mathematics to secondary-school learners and adults returning to study.',
        ['Biology', 'Mathematics'],
      ],
    );
    for (const [index, category] of DEMO_CATALOGUE.categories.entries()) {
      await client.query(
        `INSERT INTO category (id, tenant_id, slug, name, position) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [category.id, tenantId, category.slug, category.name, index],
      );
      for (const [position, subject] of category.subjects.entries()) {
        await client.query(
          `INSERT INTO subject (id, tenant_id, category_id, slug, name, position) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [subject.id, tenantId, category.id, subject.slug, subject.name, position],
        );
      }
    }
    for (const course of DEMO_CATALOGUE.courses) {
      const inserted = await client.query(
        `INSERT INTO course (id, tenant_id, owner_membership_id, subject_id, slug, title, subtitle, description_json,
           description_text, outcomes, level, tags, status, first_published_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::"CourseLevel", $12, 'PUBLISHED', now(), now())
         ON CONFLICT DO NOTHING`,
        [
          course.id,
          tenantId,
          membershipId,
          course.subjectId,
          course.slug,
          course.title,
          course.subtitle,
          JSON.stringify(course.description),
          course.description.content.map((paragraph) => paragraph.content[0]?.text ?? '').join(' '),
          course.outcomes,
          course.level,
          course.tags,
        ],
      );
      if (inserted.rowCount === 0) continue; // already seeded: leave any local edits alone
      for (const [sectionIndex, section] of course.sections.entries()) {
        const created = await client.query<{ id: string }>(
          'INSERT INTO section (tenant_id, course_id, title, position) VALUES ($1, $2, $3, $4) RETURNING id',
          [tenantId, course.id, section.title, sectionIndex],
        );
        for (const [lessonIndex, title] of section.lessons.entries()) {
          await client.query(
            `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, content_json, is_preview,
               duration_seconds)
             VALUES ($1, $2, $3, $4, 'TEXT', $5, $6, $7, 300)`,
            [
              tenantId,
              course.id,
              created.rows[0]!.id,
              title,
              lessonIndex,
              JSON.stringify(doc(`${title}: demo reading. Replace this text in Studio.`)),
              sectionIndex === 0 && lessonIndex === 0,
            ],
          );
        }
      }
    }
  });
}

async function main(): Promise<void> {
  const env = loadMigratorEnv();
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo schools in production.');

  const client = new Client({
    connectionString: env.DATABASE_URL_MIGRATOR,
    application_name: 'studyhub-seed',
  });
  await client.connect();
  const tenantIds: Partial<Record<string, string>> = {};
  try {
    for (const tenant of DEMO_TENANTS) {
      const result = await provisionTenant(client, tenant);
      if (result.outcome === 'created') {
        tenantIds[tenant.slug] = result.tenantId;
        console.log(`${tenant.hostname}: created`);
        continue;
      }
      const tenantId = await existingTenantId(process.env.DATABASE_URL_APP, tenant.hostname);
      if (tenantId === undefined) {
        console.log(`${tenant.hostname}: already present (set DATABASE_URL_APP to refresh it)`);
        continue;
      }
      tenantIds[tenant.slug] = tenantId;
      await withContext(client, { 'app.tenant_id': tenantId }, () =>
        writeTenantProfile(client, tenantId, tenant.name, tenant.branding),
      );
      console.log(`${tenant.hostname}: already present (branding refreshed)`);
    }
    await seedAccounts(client, tenantIds);
    if (tenantIds.acme !== undefined) {
      await seedCatalogue(client, tenantIds.acme);
      console.log('acme.localhost: demo catalogue present');
    }
    console.log(
      `demo accounts: ${[...DEMO_ACCOUNTS.map((a) => a.email), DEMO_STAFF.email].join(', ')} (password: ${DEMO_PASSWORD})`,
    );
  } finally {
    await client.end();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : `Seed failed: ${String(error)}`);
    process.exit(1);
  });
}
