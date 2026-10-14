'use client';

import type { CourseViewer } from '@studyhub/contracts';
import { Alert, Button, buttonClasses, ProgressLine } from '@studyhub/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { callApi, reloadTo, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { LearnTexts } from '../lib/learn-texts-type';

/**
 * The landing page's primary action (S-P03 sticky card; F14): Enrol for free, Continue, open as the
 * course owner or an administrator, or "buying opens soon" for paid courses (M8).
 */
export function CourseAction({
  course,
  viewer,
  texts,
}: {
  course: { id: string; slug: string; priceMinor: number };
  viewer: CourseViewer;
  texts: LearnTexts;
}) {
  const c = texts.cta;
  const [busy, setBusy] = useState(false);
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
    return (
      <Alert tone="info" title={c.paidSoon}>
        {c.paidSoonHint}
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
