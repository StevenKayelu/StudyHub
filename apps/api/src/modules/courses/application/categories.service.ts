import { Injectable } from '@nestjs/common';
import type { CategoryTree } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb } from '../../platform';
import { nextFreeSlug, slugify } from '../domain/course-rules';

/** Categories and subjects (F08): two levels, per school; archived, never deleted while referenced. */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** The tree; archived entries only for administrators. */
  async tree(includeArchived: boolean): Promise<CategoryTree> {
    const categories = await this.db.run((tx) =>
      tx.category.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          slug: true,
          name: true,
          archivedAt: true,
          subjects: {
            where: includeArchived ? {} : { archivedAt: null },
            orderBy: [{ position: 'asc' }, { name: 'asc' }],
            select: { id: true, slug: true, name: true, archivedAt: true },
          },
        },
      }),
    );
    return {
      categories: categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        archived: c.archivedAt !== null,
        subjects: c.subjects.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          archived: s.archivedAt !== null,
        })),
      })),
    };
  }

  async createCategory(
    actor: TenantActor,
    input: { name: string; slug?: string | undefined },
  ): Promise<{ id: string }> {
    this.requireAdmin(actor);
    return this.db.run(async (tx) => {
      const taken = new Set((await tx.category.findMany({ select: { slug: true } })).map((c) => c.slug));
      const slug = input.slug ?? nextFreeSlug(slugify(input.name), taken);
      if (taken.has(slug)) throw new AppError('SLUG_TAKEN');
      const position = await tx.category.count();
      const created = await tx.category.create({
        data: { tenantId: requireTenantId(), name: input.name, slug, position },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'category.created',
        entityType: 'category',
        entityId: created.id,
        actorId: actor.userId,
        after: { name: input.name, slug },
      });
      return created;
    });
  }

  async createSubject(
    actor: TenantActor,
    input: { categoryId: string; name: string; slug?: string | undefined },
  ): Promise<{ id: string }> {
    this.requireAdmin(actor);
    return this.db.run(async (tx) => {
      const category = await tx.category.findFirst({ where: { id: input.categoryId }, select: { id: true } });
      if (category === null) throw new AppError('NOT_FOUND');
      const taken = new Set((await tx.subject.findMany({ select: { slug: true } })).map((s) => s.slug));
      const slug = input.slug ?? nextFreeSlug(slugify(input.name), taken);
      if (taken.has(slug)) throw new AppError('SLUG_TAKEN');
      const position = await tx.subject.count({ where: { categoryId: input.categoryId } });
      const created = await tx.subject.create({
        data: { tenantId: requireTenantId(), categoryId: input.categoryId, name: input.name, slug, position },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'subject.created',
        entityType: 'subject',
        entityId: created.id,
        actorId: actor.userId,
        after: { name: input.name, slug },
      });
      return created;
    });
  }

  /** Rename, reorder, archive or restore a category or subject (`kind` picks which). */
  async update(
    actor: TenantActor,
    kind: 'category' | 'subject',
    id: string,
    input: { name?: string | undefined; position?: number | undefined; archived?: boolean | undefined },
  ): Promise<void> {
    this.requireAdmin(actor);
    await this.db.run(async (tx) => {
      const data = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.position !== undefined && { position: input.position }),
        ...(input.archived !== undefined && { archivedAt: input.archived ? new Date() : null }),
      };
      const result =
        kind === 'category'
          ? await tx.category.updateMany({ where: { id }, data })
          : await tx.subject.updateMany({ where: { id }, data });
      if (result.count === 0) throw new AppError('NOT_FOUND');
      await this.audit.record(tx, {
        action: `${kind}.updated`,
        entityType: kind,
        entityId: id,
        actorId: actor.userId,
        after: input,
      });
    });
  }

  private requireAdmin(actor: TenantActor): void {
    if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
  }
}
