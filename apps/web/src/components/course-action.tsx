'use client';

import type { CourseViewer } from '@studyhub/contracts';
import { Alert, Button, buttonClasses, ProgressLine } from '@studyhub/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { callApi, idempotencyKey, reloadTo, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { LearnTexts } from '../lib/learn-texts-type';

/**
 * The landing page's primary action (S-P03 sticky card; F14, F25): Enrol for free, Buy, Continue, or open
 * as the course owner or an administrator.
 */
export function CourseAction({
  course,
  viewer,
  texts,
  priceLabel,
  deposit,
  balance,
}: {
  course: { id: string; slug: string; priceMinor: number };
  viewer: CourseViewer;
  texts: LearnTexts;
  /** The formatted price for "Buy for K250.00" (paid courses). */
  priceLabel?: string;
  /** The course's deposit plan, formatted (offered when `viewer.depositAvailable`). */
  deposit?: { amount: string; balance: string; lessonPct: number; days: number };
  /** The viewer's unpaid balance, formatted (a deposit enrolment). */
  balance?: { amount: string; dueDate: string; overdue: boolean; lessonPct: number };
}) {
  const c = texts.cta;
  const [busy, setBusy] = useState(false);
  // One key per part, so a double click on the same button is harmless.
  const [keys] = useState(() => ({
    FULL: idempotencyKey(),
    DEPOSIT: idempotencyKey(),
    BALANCE: idempotencyKey(),
  }));
  const [error, setError] = useState<string | null>(null);
  const player = `/learn/courses/${course.id}`;

  // F25 and deposit plans: an order for the part (reused while pending, BR-35) → checkout.
  const startOrder = async (part: 'FULL' | 'DEPOSIT' | 'BALANCE') => {
    setBusy(true);
    setError(null);
    const result = await callApi<{ id: string }>(
      'POST',
      '/api/v1/orders',
      { courseId: course.id, part },
      { 'idempotency-key': keys[part] },
    );
    if (result.ok) {
      reloadTo(`/learn/orders/${result.data.id}`);
      return;
    }
    setBusy(false);
    setError(
      result.problem.code === 'EMAIL_NOT_VERIFIED'
        ? c.verifyFirst
        : splitProblem(result.problem, texts.common.networkError).summary,
    );
  };

  if (viewer.enrollment !== null) {
    const { enrollment } = viewer;
    const label = enrollment.completed
      ? c.completed
      : fill(c.progress, { percent: enrollment.progressPercent });
    return (
      <div className="flex flex-col gap-3">
        <p className="text-label">{c.enrolled}</p>
        {balance !== undefined ? (
          <div className="flex flex-col gap-2" data-testid="course-balance">
            {error !== null ? <Alert tone="danger">{error}</Alert> : null}
            <Alert tone={balance.overdue ? 'warning' : 'info'}>
              {fill(balance.overdue ? c.balanceOverdue : c.balanceDue, {
                percent: balance.lessonPct,
                balance: balance.amount,
                date: balance.dueDate,
              })}
            </Alert>
            <Button variant="primary" disabled={busy} onClick={() => startOrder('BALANCE')}>
              {busy ? c.starting : fill(c.payBalance, { balance: balance.amount })}
            </Button>
          </div>
        ) : null}
        <ProgressLine value={enrollment.progressPercent} max={100} label={label} />
        <NextLink
          href={
            enrollment.resumeLessonId === null ? player : `${player}/lessons/${enrollment.resumeLessonId}`
          }
          className={buttonClasses('primary')}
          data-testid="course-cta"
        >
          {enrollment.completed
            ? c.review
            : enrollment.resumeLessonTitle !== null
              ? fill(c.continue, { lesson: enrollment.resumeLessonTitle })
              : c.start}
        </NextLink>
      </div>
    );
  }

  if (viewer.canOpenWithoutEnrolment) {
    return (
      <NextLink href={player} className={buttonClasses('secondary')} data-testid="course-cta">
        {viewer.isOwner ? c.openAsOwner : c.openAsAdmin}
      </NextLink>
    );
  }

  if (course.priceMinor > 0) {
    if (!viewer.purchasable && viewer.signedIn) {
      return (
        <Alert tone="info" title={c.notForSale}>
          {c.notForSaleHint}
        </Alert>
      );
    }
    if (!viewer.signedIn) {
      return (
        <NextLink
          href={`/sign-in?returnTo=${encodeURIComponent(`/c/${course.slug}`)}`}
          className={buttonClasses('primary')}
          data-testid="course-cta"
        >
          {c.signInToBuy}
        </NextLink>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {error !== null ? <Alert tone="danger">{error}</Alert> : null}
        <Button variant="primary" disabled={busy} data-testid="course-cta" onClick={() => startOrder('FULL')}>
          {busy ? c.starting : fill(c.buy, { price: priceLabel ?? '' })}
        </Button>
        {viewer.depositAvailable && deposit !== undefined ? (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              data-testid="course-deposit"
              onClick={() => startOrder('DEPOSIT')}
            >
              {fill(c.payDeposit, { deposit: deposit.amount })}
            </Button>
            <p className="text-small text-muted">
              {fill(c.depositHint, {
                percent: deposit.lessonPct,
                balance: deposit.balance,
                days: deposit.days,
              })}
            </p>
          </>
        ) : null}
      </div>
    );
  }

  if (!viewer.signedIn) {
    return (
      <NextLink
        href={`/sign-in?returnTo=${encodeURIComponent(`/c/${course.slug}`)}`}
        className={buttonClasses('primary')}
        data-testid="course-cta"
      >
        {c.signInToEnrol}
      </NextLink>
    );
  }

  if (!viewer.canEnrolFree) return null;

  return (
    <div className="flex flex-col gap-2">
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <Button
        variant="primary"
        disabled={busy}
        data-testid="course-cta"
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await callApi<{ resumeLessonId: string | null }>(
            'POST',
            `/api/v1/courses/${encodeURIComponent(course.slug)}/enrol`,
          );
          if (result.ok) {
            const lesson = result.data.resumeLessonId;
            reloadTo(lesson === null ? player : `${player}/lessons/${lesson}`);
            return;
          }
          setBusy(false);
          setError(splitProblem(result.problem, texts.common.networkError).summary);
        }}
      >
        {busy ? c.enrolling : c.enrolFree}
      </Button>
    </div>
  );
}
