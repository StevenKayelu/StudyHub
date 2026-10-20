import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  type ConfigurationActivateRequest,
  type ConfigurationDraft,
  configurationDraftSchema,
  type ConfigurationDraftRequest,
  type ConfigurationView,
  type ManagedContentValues,
  MANAGED_CONTENT_KEYS,
  type ContentDefaultsDocument,
  contentDefaultsDocumentSchema,
} from '@studyhub/contracts';

import { AppError, currentContext, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import {
  CONTENT_CONFIG_ACTION,
  CONTENT_CONFIG_ENTITY,
  CONTENT_DEFAULTS_KEY,
  CONTENT_DRAFT_KEY,
  effectiveManagedContent,
  lockContentConfiguration,
  managedOverridesFrom,
  readContentDefaults,
} from '../../tenancy';
import { ConfigurationImportError, previewConfigurationImport } from '../domain/env-import';

type Scope = 'PLATFORM' | 'SCHOOL';
interface Writer {
  userId: string;
  membershipId?: string;
}
interface State {
  defaults: ContentDefaultsDocument;
  values: ManagedContentValues;
  lockedKeys: ContentDefaultsDocument['lockedKeys'];
  revision: string;
}

/** Persistence shared by the two realms; controllers authorize before selecting a scope. */
@Injectable()
export class ConfigurationService {
  constructor(private readonly db: TenantDb) {}

  get(scope: Scope): Promise<ConfigurationView> {
    return this.run(scope, (tx) => this.view(tx, scope));
  }

  saveDraft(scope: Scope, actor: Writer, input: ConfigurationDraftRequest): Promise<ConfigurationView> {
    return this.run(scope, async (tx) => {
      await lockContentConfiguration(tx, scope);
      const state = await this.state(tx, scope);
      this.expectRevision(input.expectedRevision, state.revision);
      this.validate(scope, input, state);
      const draft: ConfigurationDraft = {
        schemaVersion: 1,
        id: randomUUID(),
        baseRevision: state.revision,
        values: input.values,
        lockedKeys: [...new Set(input.lockedKeys)].sort(),
        reason: input.reason,
        createdAt: new Date().toISOString(),
      };
      await this.write(tx, scope, CONTENT_DRAFT_KEY, draft, actor);
      await this.audit(tx, scope, actor, 'configuration.draft_saved', undefined, {
        draftId: draft.id,
        keys: Object.keys(draft.values),
        reason: draft.reason,
      });
      return this.view(tx, scope);
    });
  }

  activate(scope: Scope, actor: Writer, input: ConfigurationActivateRequest): Promise<ConfigurationView> {
    return this.run(scope, async (tx) => {
      await lockContentConfiguration(tx, scope);
      const state = await this.state(tx, scope);
      this.expectRevision(input.expectedRevision, state.revision);
      const draft = await this.draft(tx, scope);
      if (draft === null || draft.id !== input.draftId) {
        throw new AppError('VERSION_CONFLICT', { detail: 'The saved draft changed. Reload and review it.' });
      }
      this.expectRevision(draft.baseRevision, state.revision);
      this.validate(scope, draft, state);
      const before = { schemaVersion: 1, values: state.values, lockedKeys: state.lockedKeys };
      if (scope === 'PLATFORM') {
        await this.write(
          tx,
          scope,
          CONTENT_DEFAULTS_KEY,
          {
            schemaVersion: 1,
            values: draft.values,
            lockedKeys: draft.lockedKeys,
          },
          actor,
        );
      } else {
        for (const key of MANAGED_CONTENT_KEYS) {
          const value = draft.values[key];
          if (value === undefined) {
            await tx.tenantSetting.deleteMany({ where: { key } });
          } else {
            await this.write(tx, scope, key, value, actor);
          }
        }
      }
      await this.removeDraft(tx, scope);
      await this.audit(tx, scope, actor, CONTENT_CONFIG_ACTION, before, {
        schemaVersion: 1,
        values: draft.values,
        lockedKeys: draft.lockedKeys,
        reason: draft.reason,
        draftId: draft.id,
      });
      return this.view(tx, scope);
    });
  }

  importPreview(text: string) {
    try {
      return previewConfigurationImport(text);
    } catch (error) {
      if (error instanceof ConfigurationImportError) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'text', code: 'invalid_import', message: error.message }],
        });
      }
      throw error;
    }
  }

  private run<T>(scope: Scope, fn: (tx: TenantTx) => Promise<T>) {
    return scope === 'PLATFORM' ? this.db.runPlatform(fn) : this.db.run(fn);
  }

  private async state(tx: TenantTx, scope: Scope): Promise<State> {
    const defaults = await readContentDefaults(tx);
    const values =
      scope === 'PLATFORM'
        ? defaults.values
        : managedOverridesFrom(
            await tx.tenantSetting.findMany({
              where: { key: { in: [...MANAGED_CONTENT_KEYS] } },
              select: { key: true, value: true },
            }),
          );
    const lockedKeys = scope === 'PLATFORM' ? defaults.lockedKeys : [];
    // Canonical ordering makes a digest independent of JSON object insertion order.
    const ordered = (map: ManagedContentValues) => MANAGED_CONTENT_KEYS.map((key) => [key, map[key] ?? null]);
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          scope,
          tenantId: scope === 'SCHOOL' ? requireTenantId() : null,
          schemaVersion: 1,
          defaults: ordered(defaults.values),
          lockedKeys: [...new Set(defaults.lockedKeys)].sort(),
          values: ordered(values),
        }),
      )
      .digest('hex');
    return { defaults, values, lockedKeys, revision };
  }

  private validate(scope: Scope, input: Pick<ConfigurationDraft, 'values' | 'lockedKeys'>, state: State) {
    if (scope === 'SCHOOL') {
      if (input.lockedKeys.length > 0) throw new AppError('FORBIDDEN');
      for (const key of state.defaults.lockedKeys) {
        if (input.values[key] !== undefined && input.values[key] !== state.values[key]) {
          throw new AppError('FORBIDDEN', {
            detail: 'A platform restriction prevents changing this school override.',
          });
        }
      }
    }
  }

  private expectRevision(expected: string, actual: string) {
    if (expected !== actual)
      throw new AppError('VERSION_CONFLICT', {
        detail: 'Active settings or platform restrictions changed. Reload and review a new draft.',
      });
  }

  private async draft(tx: TenantTx, scope: Scope): Promise<ConfigurationDraft | null> {
    const row =
      scope === 'PLATFORM'
        ? await tx.platformSetting.findUnique({ where: { key: CONTENT_DRAFT_KEY } })
        : await tx.tenantSetting.findFirst({ where: { key: CONTENT_DRAFT_KEY } });
    if (row === null) return null;
    const parsed = configurationDraftSchema.safeParse(row.value);
    if (!parsed.success)
      throw new AppError('SERVICE_UNAVAILABLE', { detail: 'The saved draft needs operator repair.' });
    return parsed.data;
  }

  private async view(tx: TenantTx, scope: Scope): Promise<ConfigurationView> {
    const state = await this.state(tx, scope);
    const inherited = effectiveManagedContent(state.defaults, {});
    const effective =
      scope === 'PLATFORM' ? inherited : effectiveManagedContent(state.defaults, state.values);
    const draft = await this.draft(tx, scope);
    const query = {
      where: { action: CONTENT_CONFIG_ACTION, entityType: CONTENT_CONFIG_ENTITY },
      orderBy: { id: 'desc' as const },
      take: 20,
    };
    const rows =
      scope === 'PLATFORM' ? await tx.platformAuditLog.findMany(query) : await tx.auditLog.findMany(query);
    const history: ConfigurationView['history'] = [];
    for (const row of rows) {
      const parsed = contentDefaultsDocumentSchema.safeParse(
        typeof row.after === 'object' && row.after !== null
          ? {
              schemaVersion: (row.after as Record<string, unknown>).schemaVersion,
              values: (row.after as Record<string, unknown>).values,
              lockedKeys: (row.after as Record<string, unknown>).lockedKeys,
            }
          : null,
      );
      if (parsed.success)
        history.push({
          id: row.id.toString(),
          at: row.createdAt.toISOString(),
          actorId: row.actorId,
          reason:
            typeof (row.after as Record<string, unknown>).reason === 'string'
              ? ((row.after as Record<string, unknown>).reason as string)
              : '',
          values: parsed.data.values,
          lockedKeys: parsed.data.lockedKeys,
        });
    }
    // Include the prior baseline so the very first activation is also reversible through the editor.
    const oldest = rows.at(-1);
    if (oldest !== undefined) {
      const baseline = contentDefaultsDocumentSchema.safeParse(oldest.before);
      if (baseline.success)
        history.push({
          id: `${oldest.id.toString()}:before`,
          at: oldest.createdAt.toISOString(),
          actorId: null,
          reason: 'Baseline before the earliest retained activation',
          values: baseline.data.values,
          lockedKeys: baseline.data.lockedKeys,
        });
    }
    return {
      schemaVersion: 1,
      scope,
      revision: state.revision,
      values: state.values,
      lockedKeys: scope === 'PLATFORM' ? state.lockedKeys : state.defaults.lockedKeys,
      fields: MANAGED_CONTENT_KEYS.map((key) => {
        const locked = scope === 'SCHOOL' && state.defaults.lockedKeys.includes(key);
        const override = state.values[key];
        return {
          key,
          value: effective[key],
          inheritedValue:
            scope === 'PLATFORM'
              ? effectiveManagedContent({ schemaVersion: 1, values: {}, lockedKeys: [] }, {})[key]
              : inherited[key],
          overrideValue: override ?? null,
          source: locked
            ? 'PLATFORM_ENFORCED'
            : scope === 'SCHOOL' && override !== undefined
              ? 'SCHOOL_OVERRIDE'
              : 'PLATFORM_DEFAULT',
          locked,
          effect: key === 'downloadsAllowedDefault' ? 'NEW_CONTENT' : 'NEXT_REQUEST',
        };
      }),
      draft: draft === null ? null : { ...draft, stale: draft.baseRevision !== state.revision },
      history,
    };
  }

  private async write(
    tx: TenantTx,
    scope: Scope,
    key: string,
    value: object | boolean | string,
    actor: Writer,
  ) {
    if (scope === 'PLATFORM') {
      await tx.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    } else {
      const tenantId = requireTenantId();
      const updatedBy = actor.membershipId ?? null;
      await tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key } },
        create: { tenantId, key, value, updatedBy },
        update: { value, updatedBy, updatedAt: new Date() },
      });
    }
  }

  private async removeDraft(tx: TenantTx, scope: Scope) {
    if (scope === 'PLATFORM') await tx.platformSetting.delete({ where: { key: CONTENT_DRAFT_KEY } });
    else await tx.tenantSetting.deleteMany({ where: { key: CONTENT_DRAFT_KEY } });
  }

  private async audit(
    tx: TenantTx,
    scope: Scope,
    actor: Writer,
    action: string,
    before: object | undefined,
    after: object,
  ) {
    const data = {
      action,
      entityType: CONTENT_CONFIG_ENTITY,
      actorId: actor.userId,
      requestId: currentContext()?.requestId ?? null,
      ...(before !== undefined && { before }),
      after,
    };
    if (scope === 'PLATFORM') await tx.platformAuditLog.create({ data });
    else await tx.auditLog.create({ data: { ...data, tenantId: requireTenantId() } });
  }
}
