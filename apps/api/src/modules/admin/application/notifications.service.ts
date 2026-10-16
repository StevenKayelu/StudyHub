import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationList,
  type NotificationPreferences,
} from '@studyhub/contracts';

import type { TenantActor } from '../../identity';
import { requireTenantId, TenantDb } from '../../platform';
import { requireMember } from './guards';

/** The notification centre (F33): the member's own notifications in this school, and email preferences. */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: TenantDb) {}

  async list(actor: TenantActor): Promise<NotificationList> {
    if (actor.support !== undefined) return { unread: 0, items: [] };
    return this.db.run(async (tx) => {
      const items = await tx.notification.findMany({
        where: { membershipId: actor.membershipId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      const unread = await tx.notification.count({
        where: { membershipId: actor.membershipId, readAt: null },
      });
      return {
        unread,
        items: items.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          link: n.link,
          readAt: n.readAt?.toISOString() ?? null,
          createdAt: n.createdAt.toISOString(),
        })),
      };
    });
  }

  async markRead(actor: TenantActor, input: { ids: string[] } | { all: true }): Promise<void> {
    requireMember(actor);
    await this.db.run((tx) =>
      tx.notification.updateMany({
        where: {
          membershipId: actor.membershipId,
          readAt: null,
          ...('ids' in input && { id: { in: input.ids } }),
        },
        data: { readAt: new Date() },
      }),
    );
  }

  async preferences(actor: TenantActor): Promise<NotificationPreferences> {
    requireMember(actor);
    const rows = await this.db.run((tx) =>
      tx.notificationPreference.findMany({ where: { membershipId: actor.membershipId } }),
    );
    const enabled = (category: string) => rows.find((r) => r.category === category)?.emailEnabled ?? true;
    return { learning: enabled('learning'), earnings: enabled('earnings') };
  }

  async setPreferences(actor: TenantActor, input: NotificationPreferences): Promise<NotificationPreferences> {
    requireMember(actor);
    const tenantId = requireTenantId();
    await this.db.run(async (tx) => {
      for (const category of NOTIFICATION_CATEGORIES) {
        await tx.notificationPreference.upsert({
          where: { tenantId_membershipId_category: { tenantId, membershipId: actor.membershipId, category } },
          create: { tenantId, membershipId: actor.membershipId, category, emailEnabled: input[category] },
          update: { emailEnabled: input[category], updatedAt: new Date() },
        });
      }
    });
    return input;
  }
}
