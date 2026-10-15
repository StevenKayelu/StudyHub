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
}: {
  course: { id: string; slug: string; priceMinor: number };
  viewer: CourseViewer;
  texts: LearnTexts;
  /** The formatted price for "Buy for K250.00" (paid courses). */
  priceLabel?: string;
}) {
  const c = texts.cta;
  const [busy, setBusy] = useState(false);
  const [buyKey] = useState(idempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const player = `/learn/courses/${course.id}`;

  if (viewer.enrollment !== null) {
    const { enrollment } = viewer;
    const label = enrollment.completed
      ? c.completed
      : fill(c.progress, { percent: enrollment.progressPercent });
    return (
      <div className="flex flex-col gap-3">
        <p className="text-label">{c.enrolled}</p>
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
    // F25: Buy → an order (reused while pending, BR-35) → checkout. The key makes a double click harmless.
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
            const result = await callApi<{ id: string }>(
              'POST',
              '/api/v1/orders',
              { courseId: course.id },
              { 'idempotency-key': buyKey },
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
          }}
        >
          {busy ? c.starting : fill(c.buy, { price: priceLabel ?? '' })}
        </Button>
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
