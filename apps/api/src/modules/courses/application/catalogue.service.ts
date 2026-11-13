import { Injectable } from '@nestjs/common';
import type {
  CatalogueResponse,
  CourseCard,
  CourseLanding,
  InstructorPage,
  PeriodKind,
} from '@studyhub/contracts';

import { Prisma } from '../../../generated/prisma/client';

import { paymentsProblem, planOffered } from '../../commerce';
import type { TenantActor } from '../../identity';
import { EnrollmentsService } from '../../learning';
import { AppError, TenantDb, type TenantTx } from '../../platform';
import { readCommerceSettings, readContentSettings, readFeatures } from '../../tenancy';
import { StudioService } from './studio.service';

const DEFAULT_LIMIT = 12;

interface CardRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  cover_asset_id: string | null;
  level: CourseCard['level'];
  price_minor: bigint;
  currency: string;
  lesson_count: number;
  duration_seconds: number;
  instructor_name: string | null;
  instructor_slug: string | null;
  subject_slug: string | null;
  subject_name: string | null;
  periods: { id: string; name: string; kind: PeriodKind }[];
}

/** Unique periods assigned to the course's topics. */
const PERIOD_COLUMNS = Prisma.sql`COALESCE((
         SELECT json_agg(json_build_object('id', period.id, 'name', period.name, 'kind', period.kind)
                         ORDER BY period.starts_at)
           FROM (
             SELECT DISTINCT ON (pd.id) pd.id, pd.name, pd.kind, pd.starts_at
               FROM lesson l
               JOIN academic_period pd ON pd.id = l.period_id
              WHERE l.course_id = c.id
              ORDER BY pd.id, pd.starts_at
           ) period
       ), '[]'::json) AS periods`;

/**
 * The school's public catalogue (F13, BR-26, BR-28, BR-57). Only PUBLISHED courses whose instructor is
 * not suspended; another school's courses never appear (RLS: every query runs in this school only).
 * Search: weighted full text plus trigram similarity on the title, so a one-letter typo still matches.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly db: TenantDb,
    private readonly studio: StudioService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  async search(
    actor: TenantActor | null,
    query: {
      q?: string | undefined;
      category?: string | undefined;
      subject?: string | undefined;
      level?: string | undefined;
      price?: 'free' | 'paid' | undefined;
      period?: string | undefined;
      sort?: 'relevance' | 'newest' | 'popular' | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<CatalogueResponse> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = decodeCursor(query.cursor);
    const q = (query.q ?? '').trim();
    const sort = query.sort ?? (q === '' ? 'newest' : 'relevance');
    const rows = await this.db.run(async (tx) => {
      await this.requireVisible(tx, actor);
      return tx.$queryRaw<(CardRow & { rank: number })[]>`
        SELECT c.id, c.slug, c.title, c.subtitle, c.cover_asset_id, c.level, c.price_minor, c.currency,
               (SELECT count(*)::int FROM lesson l WHERE l.course_id = c.id) AS lesson_count,
               (SELECT coalesce(sum(l.duration_seconds), 0)::int FROM lesson l WHERE l.course_id = c.id) AS duration_seconds,
               p.display_name AS instructor_name, p.slug AS instructor_slug,
               s.slug AS subject_slug, s.name AS subject_name, ${PERIOD_COLUMNS},
               CASE WHEN ${q} = '' THEN 0::real
                    ELSE ts_rank(c.search_vector, websearch_to_tsquery('simple'::regconfig, ${q}))
                         + ext.similarity(c.title, ${q}) END AS rank
          FROM course c
          LEFT JOIN instructor_profile p ON p.membership_id = c.owner_membership_id
          LEFT JOIN subject s ON s.id = c.subject_id
          LEFT JOIN category k ON k.id = s.category_id
         WHERE c.status = 'PUBLISHED'
           AND coalesce(p.status::text, 'APPROVED') <> 'SUSPENDED'
           AND (${q} = '' OR c.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${q})
                OR ext.word_similarity(${q}, c.title) > 0.4)
           AND (${query.subject ?? null}::text IS NULL OR s.slug = ${query.subject ?? null})
           AND (${query.category ?? null}::text IS NULL OR k.slug = ${query.category ?? null})
           AND (${query.level ?? null}::text IS NULL OR c.level::text = ${query.level ?? null})
           AND (${query.price ?? null}::text IS NULL
                OR (${query.price ?? null} = 'free' AND c.price_minor = 0)
                OR (${query.price ?? null} = 'paid' AND c.price_minor > 0))
           AND (${query.period ?? null}::text IS NULL
                OR (${query.period ?? null} = 'open' AND EXISTS (
                     SELECT 1 FROM lesson l WHERE l.course_id = c.id AND l.period_id IS NULL
                   ))
                OR EXISTS (
                     SELECT 1 FROM lesson l
                      WHERE l.course_id = c.id AND l.period_id::text = ${query.period ?? null}
                   ))
         ORDER BY
           CASE WHEN ${sort} = 'relevance' THEN 0 ELSE 1 END,
           CASE WHEN ${sort} = 'relevance' THEN -(CASE WHEN ${q} = '' THEN 0::real
                ELSE ts_rank(c.search_vector, websearch_to_tsquery('simple'::regconfig, ${q})) + ext.similarity(c.title, ${q}) END) END,
           CASE WHEN ${sort} = 'popular' THEN -c.enrollment_count END,
           c.published_at DESC, c.id
         LIMIT ${limit + 1} OFFSET ${offset}`;
    });
    const page = rows.slice(0, limit);
    return {
      items: await this.cards(page),
      page: {
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      },
    };
  }

  async landing(actor: TenantActor | null, slug: string): Promise<CourseLanding> {
    const data = await this.db.run(async (tx) => {
      await this.requireVisible(tx, actor);
      const course = await tx.course.findFirst({
        where: { slug, status: 'PUBLISHED' },
        include: {
          subject: { select: { slug: true, name: true } },
          sections: {
            orderBy: { position: 'asc' },
            select: {
              title: true,
              lessons: {
                orderBy: { position: 'asc' },
                select: {
                  id: true,
                  title: true,
                  type: true,
                  durationSeconds: true,
                  isPreview: true,
                  period: { select: { id: true, name: true, kind: true } },
                },
              },
            },
          },
        },
      });
      if (course === null) throw new AppError('NOT_FOUND');
      const profile = await tx.instructorProfile.findUnique({
        where: { membershipId: course.ownerMembershipId },
      });
      if (profile?.status === 'SUSPENDED') throw new AppError('NOT_FOUND');
      const { depositPlans } = await readCommerceSettings(tx);
      return { course, profile, depositPlans };
    });
    const { course, profile, depositPlans } = data;
    const price = Number(course.priceMinor);
    const plan =
      course.depositMinor === null || course.depositLessonPct === null || course.balanceDueDays === null
        ? null
        : {
            depositMinor: Number(course.depositMinor),
            lessonPct: course.depositLessonPct,
            balanceDueDays: course.balanceDueDays,
          };
    // Offered only while the school allows deposit plans and the plan still fits the price and rules.
    const offeredPlan = planOffered(price, plan, depositPlans) ? plan : null;
    const lessons = course.sections.flatMap((s) => s.lessons);
    const covers = await this.studio.coverUrls([course.coverAssetId]);
    const viewer = await this.enrollments.viewer(actor, {
      id: course.id,
      ownerMembershipId: course.ownerMembershipId,
      priceMinor: Number(course.priceMinor),
      currency: course.currency,
    });
    // M8: "Buy" only where the school can sell this course now (BR-54, BR-04).
    if (
      course.priceMinor > 0n &&
      viewer.enrollment === null &&
      !viewer.isOwner &&
      course.status === 'PUBLISHED'
    ) {
      viewer.purchasable =
        (await this.db.run((tx) => paymentsProblem(tx, course.ownerMembershipId))) === null;
      viewer.depositAvailable = viewer.purchasable && offeredPlan !== null;
    }
    return {
      id: course.id,
      slug: course.slug,
      title: course.title,
      subtitle: course.subtitle,
      coverUrl: course.coverAssetId === null ? null : (covers.get(course.coverAssetId) ?? null),
      level: course.level,
      priceMinor: Number(course.priceMinor),
      currency: course.currency,
      depositPlan:
        offeredPlan === null ? null : { ...offeredPlan, balanceMinor: price - offeredPlan.depositMinor },
      lessonCount: lessons.length,
      durationSeconds: lessons.reduce((total, l) => total + (l.durationSeconds ?? 0), 0),
      instructor: { name: profile?.displayName ?? '', slug: profile?.slug ?? null },
      subject: course.subject === null ? null : { slug: course.subject.slug, name: course.subject.name },
      periods: uniquePeriods(lessons.flatMap((lesson) => (lesson.period === null ? [] : [lesson.period]))),
      description: course.descriptionJson,
      outcomes: course.outcomes,
      requirements: course.requirements,
      language: course.language,
      publishedAt: course.publishedAt?.toISOString() ?? null,
      sections: course.sections,
      instructorProfile:
        profile === null
          ? null
          : { name: profile.displayName, slug: profile.slug, headline: profile.headline, bio: profile.bio },
      viewer,
    };
  }

  /** F07: public instructor page; a suspended instructor is not found (F07 AC). */
  async instructor(actor: TenantActor | null, slug: string): Promise<InstructorPage> {
    const profile = await this.db.run(async (tx) => {
      await this.requireVisible(tx, actor);
      const found = await tx.instructorProfile.findFirst({ where: { slug, status: 'APPROVED' } });
      if (found === null) throw new AppError('NOT_FOUND');
      return found;
    });
    const courses = await this.db.run(
      (tx) =>
        tx.$queryRaw<CardRow[]>`
        SELECT c.id, c.slug, c.title, c.subtitle, c.cover_asset_id, c.level, c.price_minor, c.currency,
               (SELECT count(*)::int FROM lesson l WHERE l.course_id = c.id) AS lesson_count,
               (SELECT coalesce(sum(l.duration_seconds), 0)::int FROM lesson l WHERE l.course_id = c.id) AS duration_seconds,
               ${profile.displayName}::text AS instructor_name, ${profile.slug}::text AS instructor_slug,
               s.slug AS subject_slug, s.name AS subject_name, ${PERIOD_COLUMNS}
          FROM course c LEFT JOIN subject s ON s.id = c.subject_id
         WHERE c.status = 'PUBLISHED' AND c.owner_membership_id = ${profile.membershipId}::uuid
         ORDER BY c.published_at DESC`,
    );
    return {
      slug: profile.slug,
      displayName: profile.displayName,
      headline: profile.headline,
      bio: profile.bio,
      subjects: profile.subjects,
      courses: await this.cards(courses),
    };
  }

  /** BR-57 for routes outside this service (the period list). */
  async requireCatalogue(actor: TenantActor | null): Promise<void> {
    await this.db.run((tx) => this.requireVisible(tx, actor));
  }

  /** BR-57: a members-only catalogue needs a signed-in member of this school. */
  private async requireVisible(tx: TenantTx, actor: TenantActor | null): Promise<void> {
    if (actor !== null) return;
    const settings = await readContentSettings(tx);
    if (!(await readFeatures(tx)).publicCatalog || settings.catalogVisibility === 'MEMBERS_ONLY') {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  private async cards(rows: CardRow[]): Promise<CourseCard[]> {
    const covers = await this.studio.coverUrls(rows.map((r) => r.cover_asset_id));
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      subtitle: r.subtitle,
      coverUrl: r.cover_asset_id === null ? null : (covers.get(r.cover_asset_id) ?? null),
      level: r.level,
      priceMinor: Number(r.price_minor),
      currency: r.currency,
      lessonCount: r.lesson_count,
      durationSeconds: r.duration_seconds,
      instructor: { name: r.instructor_name ?? '', slug: r.instructor_slug },
      subject: r.subject_slug === null ? null : { slug: r.subject_slug, name: r.subject_name ?? '' },
      periods: r.periods,
    }));
  }
}

function uniquePeriods(periods: { id: string; name: string; kind: PeriodKind }[]) {
  return [...new Map(periods.map((period) => [period.id, period])).values()];
}

/** Opaque page cursor (an offset; the catalogue is small per school). */
function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^o:(\d{1,6})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match === null ? 0 : Number(match[1]);
}
