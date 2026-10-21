import type { TenantTx } from '../../platform';
import { assertBalanced, type JournalDraft } from '../domain/ledger';

/**
 * Posts a journal to the platform ledger in the caller's platform transaction. A business event is
 * posted at most once: posting the same (source, kind) again returns the existing journal instead of a
 * second one. The database checks the balance again at commit (migration 0015).
 */
export async function postJournal(
  tx: TenantTx,
  journal: JournalDraft,
  options: { actorId: string | null; reversesJournalId?: string | null },
): Promise<{ id: string; created: boolean }> {
  assertBalanced(journal);
  const existing = await tx.platformLedgerJournal.findFirst({
    where: { sourceType: journal.sourceType, sourceId: journal.sourceId, kind: journal.kind },
    select: { id: true },
  });
  if (existing !== null) return { id: existing.id, created: false };
  const created = await tx.platformLedgerJournal.create({
    data: {
      kind: journal.kind,
      description: journal.description,
      currency: journal.currency,
      sourceType: journal.sourceType,
      sourceId: journal.sourceId,
      reversesJournalId: options.reversesJournalId ?? null,
      createdBy: options.actorId,
    },
    select: { id: true },
  });
  await tx.platformLedgerLine.createMany({
    data: journal.lines.map((line) => ({
      journalId: created.id,
      accountCode: line.account,
      tenantRef: line.tenantRef,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency: journal.currency,
      memo: line.memo,
    })),
  });
  return { id: created.id, created: true };
}

/** Reads a posted journal back as a draft (for reversing it). */
export async function readJournal(tx: TenantTx, id: string): Promise<JournalDraft & { id: string }> {
  const journal = await tx.platformLedgerJournal.findUniqueOrThrow({
    where: { id },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  return {
    id: journal.id,
    kind: journal.kind,
    description: journal.description,
    currency: journal.currency,
    sourceType: journal.sourceType,
    sourceId: journal.sourceId,
    lines: journal.lines.map((line) => ({
      account: line.accountCode,
      tenantRef: line.tenantRef,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      memo: line.memo,
    })),
  };
}
