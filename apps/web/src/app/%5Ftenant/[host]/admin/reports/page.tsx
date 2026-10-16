import { exportListSchema, REPORT_EXPORT_TYPES, reportOverviewSchema } from '@studyhub/contracts';
import { Button, Card, formatMoney, StatCard, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { ExportList } from '../../../../../components/export-list';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.reports'))('title') };
}

type Search = Promise<Record<string, string | string[] | undefined>>;
const field = 'min-h-11 rounded-md border border-strong bg-surface px-3';
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** S-AD07 Reports & exports (F32): figures for a range, and CSV exports that add up to the same totals. */
export default async function ReportsPage({ searchParams }: { searchParams: Search }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const params = await searchParams;
  const to = isDay(params.to) ? params.to : new Date().toISOString().slice(0, 10);
  const from = isDay(params.from)
    ? params.from
    : new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
  const interval = params.interval === 'week' || params.interval === 'month' ? params.interval : 'day';
  const t = await getTranslations();
  const locale = await getLocale();
  const format = await getFormatter();
  const terms = await getTerms(tenant, locale);
  const report = await fetchAdmin(
    `/api/v1/admin/reports/overview?from=${from}&to=${to}&interval=${interval}`,
    reportOverviewSchema,
  );
  const exports = await fetchAdmin('/api/v1/admin/exports', exportListSchema);
  const texts = await actionTexts();
  const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/reports"
      title={t('schoolAdmin.reports.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/reports', label: t('schoolAdmin.reports.title') },
      ]}
    >
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.reports.from')}
          <input type="date" name="from" defaultValue={from} className={field} required />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.reports.to')}
          <input type="date" name="to" defaultValue={to} className={field} required />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.reports.interval')}
          <select name="interval" defaultValue={interval} className={field}>
            {(['day', 'week', 'month'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`schoolAdmin.reports.intervals.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t('schoolAdmin.reports.apply')}
        </Button>
      </form>

      {report === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : report === null ? null : (
        <>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6" data-testid="report-totals">
            <StatCard
              label={t('schoolAdmin.reports.gross')}
              value={money(report.revenue.gross, report.currency)}
            />
            <StatCard
              label={t('schoolAdmin.reports.refunds')}
              value={money(report.revenue.refunds, report.currency)}
            />
            <StatCard
              label={t('schoolAdmin.reports.net')}
              value={money(report.revenue.net, report.currency)}
            />
            <StatCard label={t('schoolAdmin.reports.orders')} value={String(report.revenue.orders)} />
            <StatCard label={t('schoolAdmin.reports.newLearners')} value={String(report.newLearners)} />
            <StatCard label={t('schoolAdmin.reports.enrolments')} value={String(report.enrolments)} />
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-body-sm">
                <thead className="text-caption text-muted">
                  <tr>
                    <th scope="col" className="py-2 pe-4">
                      {t('schoolAdmin.reports.period')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-end">
                      {t('schoolAdmin.reports.gross')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-end">
                      {t('schoolAdmin.reports.refunds')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-end">
                      {t('schoolAdmin.reports.net')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-end">
                      {t('schoolAdmin.reports.enrolments')}
                    </th>
                    <th scope="col" className="py-2 text-end">
                      {t('schoolAdmin.reports.newLearners')}
                    </th>
                  </tr>
                </thead>
                <tbody className="tabular divide-y divide-line">
                  {report.series.map((row) => (
                    <tr key={row.period}>
                      <th scope="row" className="py-2 pe-4 font-normal">
                        {format.dateTime(new Date(`${row.period}T00:00:00Z`), {
                          dateStyle: 'medium',
                          timeZone: 'UTC',
                        })}
                      </th>
                      <td className="py-2 pe-4 text-end">{money(row.gross, report.currency)}</td>
                      <td className="py-2 pe-4 text-end">{money(row.refunds, report.currency)}</td>
                      <td className="py-2 pe-4 text-end">{money(row.net, report.currency)}</td>
                      <td className="py-2 pe-4 text-end">{row.enrolments}</td>
                      <td className="py-2 text-end">{row.newLearners}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <h2 className="text-h3">{t('schoolAdmin.reports.topCourses', terms)}</h2>
              {report.topCourses.length === 0 ? (
                <p className="mt-2 text-body text-muted">{t('schoolAdmin.reports.noData')}</p>
              ) : (
                <ol className="mt-2 flex flex-col gap-2">
                  {report.topCourses.map((course) => (
                    <li key={course.courseId} className="flex justify-between gap-3 text-body">
                      <span>{course.title}</span>
                      <span className="tabular text-muted">
                        {course.enrolments} · {money(course.revenueMinor, report.currency)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Card>
              <h2 className="text-h3">{t('schoolAdmin.reports.paymentSuccess')}</h2>
              {report.paymentSuccess.length === 0 ? (
                <p className="mt-2 text-body text-muted">{t('schoolAdmin.reports.noData')}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {report.paymentSuccess.map((row) => (
                    <li key={row.method} className="flex justify-between gap-3 text-body">
                      <span>{t(`schoolAdmin.reports.methods.${row.method}`)}</span>
                      <span className="tabular text-muted">
                        {t('schoolAdmin.reports.rate', {
                          succeeded: row.succeeded,
                          attempted: row.attempted,
                          rate: row.rate ?? 0,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <section id="exports" aria-labelledby="exports-title" className="flex flex-col gap-3">
        <h2 id="exports-title" className="text-h3">
          {t('schoolAdmin.reports.exportsTitle')}
        </h2>
        <p className="text-body-sm text-muted">{t('schoolAdmin.reports.exportHint')}</p>
        <div className="flex flex-wrap gap-2">
          {REPORT_EXPORT_TYPES.map((type) => (
            <ActionButton
              key={type}
              label={t('schoolAdmin.reports.export', { type: t(`schoolAdmin.reports.exportTypes.${type}`) })}
              method="POST"
              path="/api/v1/admin/exports"
              body={{ type, from, to }}
              texts={texts}
              testId={`export-${type.toLowerCase()}`}
            />
          ))}
        </div>
        {exports === 'denied' ? null : <ExportList exports={exports?.exports ?? []} />}
      </section>
    </AdminFrame>
  );
}
