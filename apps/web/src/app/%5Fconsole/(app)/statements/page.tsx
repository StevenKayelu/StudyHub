import { consoleStatementListSchema, periodSchema } from '@studyhub/contracts';
import { Button, Card, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../components/action-button';
import { ApiForm } from '../../../../components/api-form';
import { STATEMENT_BADGES } from '../../../../components/order-badges';
import { StatementLines } from '../../../../components/statement-lines';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { actionTexts, fetchConsole, formTexts } from '../../../../lib/admin-api';

export const metadata: Metadata = { title: 'Statements' };

type Search = Promise<Record<string, string | string[] | undefined>>;
const field = 'min-h-11 rounded-md border border-strong bg-surface px-3';

/** The previous calendar month (UTC), the usual month to bill. */
function lastMonth(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return date.toISOString().slice(0, 7);
}

/**
 * W8 Platform statements: generate drafts for a month from recorded payments and refunds (BR-63), then
 * issue (amounts frozen), mark paid with the external reference, or void.
 */
export default async function StatementsPage({ searchParams }: { searchParams: Search }) {
  const t = await getTranslations();
  const s = (key: string, values?: Record<string, string>) => t(`platformConsole.statements.${key}`, values);
  const params = await searchParams;
  const period = periodSchema.safeParse(params.period).data ?? lastMonth();
  const data = await fetchConsole(`/statements?period=${period}`, consoleStatementListSchema);
  const texts = await actionTexts();

  return (
    <ConsoleFrame current="/statements" title={s('title')}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="flex flex-col gap-1 text-label">
            {s('period')}
            <input type="month" name="period" defaultValue={period} className={field} />
          </label>
          <Button type="submit" variant="secondary">
            {t('platformConsole.audit.filter')}
          </Button>
        </form>
        <ApiForm
          method="POST"
          path="/api/console/statements/generate"
          body={{ period }}
          fields={[]}
          submitLabel={`${s('generate')} · ${period}`}
          successMessage={t.raw('platformConsole.statements.generated') as string}
          texts={await formTexts()}
          testId="generate-statements"
        />
      </div>
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : data.statements.length === 0 ? (
        <StatePanel kind="empty" title={s('none')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="console-statements">
          {data.statements.map((statement) => (
            <Card key={statement.id}>
              <div className="flex flex-col gap-3" data-statement={statement.tenantName}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <NextLink href={`/tenants/${statement.tenantId}`} className="text-label">
                    {statement.tenantName}
                  </NextLink>
                  <StatusBadge status={STATEMENT_BADGES[statement.status]}>
                    {t(`schoolAdmin.billing.statuses.${statement.status}`)}
                  </StatusBadge>
                </div>
                <StatementLines statement={statement} />
                <div className="flex flex-wrap gap-2">
                  {statement.status === 'DRAFT' ? (
                    <ActionButton
                      label={s('issue')}
                      method="POST"
                      path={`/api/console/statements/${statement.id}/issue`}
                      variant="primary"
                      texts={texts}
                      testId="issue-statement"
                      confirm={{
                        title: s('issueTitle', { school: statement.tenantName }),
                        description: s('issueBody'),
                        confirmLabel: s('issue'),
                      }}
                    />
                  ) : null}
                  {statement.status === 'ISSUED' ? (
                    <ActionButton
                      label={s('markPaid')}
                      method="POST"
                      path={`/api/console/statements/${statement.id}/mark-paid`}
                      variant="primary"
                      texts={texts}
                      testId="mark-paid"
                      confirm={{
                        title: s('markPaid'),
                        confirmLabel: s('markPaid'),
                        extraField: {
                          name: 'externalReference',
                          label: s('externalReference'),
                          required: true,
                        },
                      }}
                    />
                  ) : null}
                  {statement.status === 'DRAFT' || statement.status === 'ISSUED' ? (
                    <ActionButton
                      label={s('void')}
                      method="POST"
                      path={`/api/console/statements/${statement.id}/void`}
                      variant="danger"
                      texts={texts}
                      testId="void-statement"
                      confirm={{ title: s('voidTitle'), confirmLabel: s('void') }}
                    />
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </ConsoleFrame>
  );
}
