'use client';

import type { LessonDetail, Outline } from '@studyhub/contracts';
import { Alert, Button, Card, StatePanel, StatusBadge } from '@studyhub/ui';
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Pencil, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { type FormEvent, useState } from 'react';

import { type ApiResult, callApi, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { StudioTexts } from '../lib/studio-texts-type';

const LESSON_TYPES = ['TEXT', 'VIDEO', 'FILE', 'QUIZ'] as const;

type Order = { id: string; lessonIds: string[] }[];

const orderOf = (outline: Outline): Order =>
  outline.sections.map((section) => ({
    id: section.id,
    lessonIds: section.lessons.map((lesson) => lesson.id),
  }));

function swap<T>(items: T[], from: number, to: number): T[] {
  const copy = [...items];
  [copy[from], copy[to]] = [copy[to]!, copy[from]!];
  return copy;
}

const iconButton =
  'inline-flex size-9 items-center justify-center rounded-sm text-muted hover:bg-sunken hover:text-ink disabled:opacity-40';

/**
 * S-T03 Outline: sections and lessons, added, renamed, deleted and moved with buttons (keyboard and
 * screen-reader friendly; no drag-only interaction, 06 §8). Every change returns the new outline and its
 * version; a stale version (another tab) reloads the latest outline and says so.
 */
export function OutlineEditor({
  initial,
  editable,
  texts,
}: {
  initial: Outline;
  editable: boolean;
  texts: StudioTexts;
}) {
  const s = texts.studio.outline;
  const [outline, setOutline] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'warning'; text: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const base = `/studio/courses/${outline.courseId}`;

  async function run(call: () => Promise<ApiResult<Outline | LessonDetail>>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    try {
      const result = await call();
      if (result.ok) {
        if ('sections' in result.data) {
          setOutline(result.data);
        } else {
          const fresh = await callApi<Outline>('GET', `/api/v1/studio/courses/${outline.courseId}/outline`);
          if (fresh.ok) setOutline(fresh.data);
        }
        return true;
      }
      if (result.problem.code === 'VERSION_CONFLICT') {
        const fresh = await callApi<Outline>('GET', `/api/v1/studio/courses/${outline.courseId}/outline`);
        if (fresh.ok) setOutline(fresh.data);
        setMessage({ tone: 'warning', text: s.conflict });
        return false;
      }
      const split = splitProblem(result.problem, texts.common.networkError);
      setMessage({ tone: 'danger', text: split.summary ?? Object.values(split.fields)[0] ?? '' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const reorder = (sections: Order) =>
    run(() =>
      callApi<Outline>('PUT', `/api/v1/studio/courses/${outline.courseId}/outline/order`, {
        version: outline.version,
        sections,
      }),
    );

  function moveLesson(sectionIndex: number, lessonIndex: number, direction: -1 | 1, acrossSections: boolean) {
    const order = orderOf(outline);
    const section = order[sectionIndex]!;
    if (!acrossSections) {
      section.lessonIds = swap(section.lessonIds, lessonIndex, lessonIndex + direction);
    } else {
      const target = order[sectionIndex + direction]!;
      const [lessonId] = section.lessonIds.splice(lessonIndex, 1);
      if (direction === -1) target.lessonIds.push(lessonId!);
      else target.lessonIds.unshift(lessonId!);
    }
    void reorder(order);
  }

  async function submitNamed(
    event: FormEvent<HTMLFormElement>,
    call: (title: string) => Promise<ApiResult<Outline | LessonDetail>>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = String(new FormData(form).get('title') ?? '').trim();
    if (title === '') return;
    if (await run(() => call(title))) form.reset();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="outline-editor">
      <div aria-live="polite">
        {message !== null ? <Alert tone={message.tone} role="alert" title={message.text} /> : null}
      </div>
      {outline.sections.length === 0 ? (
        <StatePanel kind="empty" title={s.emptyTitle} message={s.emptyMessage} headingLevel={2} />
      ) : null}
      <ol className="flex flex-col gap-4">
        {outline.sections.map((section, sectionIndex) => (
          <li key={section.id}>
            <Card className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {renaming === section.id ? (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={async (event) => {
                      await submitNamed(event, (title) =>
                        callApi<Outline>(
                          'PATCH',
                          `/api/v1/studio/courses/${outline.courseId}/sections/${section.id}`,
                          {
                            title,
                          },
                        ),
                      );
                      setRenaming(null);
                    }}
                  >
                    <label className="sr-only" htmlFor={`rename-${section.id}`}>
                      {s.sectionTitle}
                    </label>
                    <input
                      id={`rename-${section.id}`}
                      name="title"
                      defaultValue={section.title}
                      maxLength={120}
                      autoFocus
                      className="h-10 flex-1 rounded-md border border-strong bg-surface px-3"
                    />
                    <Button type="submit" size="sm" variant="primary">
                      {texts.common.save}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                      {texts.common.cancel}
                    </Button>
                  </form>
                ) : (
                  <h2 className="flex-1 text-h3">{section.title}</h2>
                )}
                {editable && renaming !== section.id ? (
                  <div className="flex">
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`${texts.common.moveUp}: ${section.title}`}
                      disabled={busy || sectionIndex === 0}
                      onClick={() => void reorder(swap(orderOf(outline), sectionIndex, sectionIndex - 1))}
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`${texts.common.moveDown}: ${section.title}`}
                      disabled={busy || sectionIndex === outline.sections.length - 1}
                      onClick={() => void reorder(swap(orderOf(outline), sectionIndex, sectionIndex + 1))}
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`${s.renameSection}: ${section.title}`}
                      disabled={busy}
                      onClick={() => setRenaming(section.id)}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`${s.deleteSection}: ${section.title}`}
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(fill(s.deleteSectionConfirm, { title: section.title }))) return;
                        void run(() =>
                          callApi<Outline>(
                            'DELETE',
                            `/api/v1/studio/courses/${outline.courseId}/sections/${section.id}`,
                          ),
                        );
                      }}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  </div>
                ) : null}
              </div>

              {section.lessons.length === 0 ? <p className="text-body-sm text-muted">{s.noLessons}</p> : null}
              <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
                {section.lessons.map((lesson, lessonIndex) => (
                  <li key={lesson.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="w-16 shrink-0 text-caption text-muted">
                      {texts.lessonTypes[lesson.type]}
                    </span>
                    <NextLink href={`${base}/lessons/${lesson.id}`} className="min-w-0 flex-1 truncate">
                      {lesson.title}
                    </NextLink>
                    {lesson.isPreview ? <span className="text-caption text-accent">{s.preview}</span> : null}
                    <StatusBadge status={lesson.ready ? 'published' : 'attention'}>
                      {lesson.ready ? s.ready : s.needsContent}
                    </StatusBadge>
                    {editable ? (
                      <div className="flex">
                        <button
                          type="button"
                          className={iconButton}
                          aria-label={`${s.moveToPrevious}: ${lesson.title}`}
                          disabled={busy || sectionIndex === 0 || lessonIndex !== 0}
                          hidden={sectionIndex === 0 || lessonIndex !== 0}
                          onClick={() => moveLesson(sectionIndex, lessonIndex, -1, true)}
                        >
                          <ChevronsUp aria-hidden="true" className="size-4" />
                        </button>
                        <button
                          type="button"
                          className={iconButton}
                          aria-label={`${texts.common.moveUp}: ${lesson.title}`}
                          disabled={busy || lessonIndex === 0}
                          onClick={() => moveLesson(sectionIndex, lessonIndex, -1, false)}
                        >
                          <ArrowUp aria-hidden="true" className="size-4" />
                        </button>
                        <button
                          type="button"
                          className={iconButton}
                          aria-label={`${texts.common.moveDown}: ${lesson.title}`}
                          disabled={busy || lessonIndex === section.lessons.length - 1}
                          onClick={() => moveLesson(sectionIndex, lessonIndex, 1, false)}
                        >
                          <ArrowDown aria-hidden="true" className="size-4" />
                        </button>
                        <button
                          type="button"
                          className={iconButton}
                          aria-label={`${s.moveToNext}: ${lesson.title}`}
                          hidden={
                            sectionIndex === outline.sections.length - 1 ||
                            lessonIndex !== section.lessons.length - 1
                          }
                          disabled={busy}
                          onClick={() => moveLesson(sectionIndex, lessonIndex, 1, true)}
                        >
                          <ChevronsDown aria-hidden="true" className="size-4" />
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>

              {editable ? (
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    const type = String(new FormData(event.currentTarget).get('type') ?? 'TEXT');
                    void submitNamed(event, (title) =>
                      callApi<LessonDetail>('POST', `/api/v1/studio/courses/${outline.courseId}/lessons`, {
                        sectionId: section.id,
                        title,
                        type,
                      }),
                    );
                  }}
                >
                  <label className="flex flex-1 flex-col gap-1 text-label">
                    {s.lessonTitle}
                    <input
                      name="title"
                      maxLength={120}
                      required
                      className="h-10 rounded-md border border-strong bg-surface px-3 font-normal"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-label">
                    {s.lessonType}
                    <select
                      name="type"
                      className="h-10 rounded-md border border-strong bg-surface px-3 font-normal"
                    >
                      {LESSON_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {texts.lessonTypes[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button type="submit" variant="secondary" disabled={busy}>
                    {s.addLesson}
                  </Button>
                </form>
              ) : null}
            </Card>
          </li>
        ))}
      </ol>

      {editable ? (
        <Card>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) =>
              void submitNamed(event, (title) =>
                callApi<Outline>('POST', `/api/v1/studio/courses/${outline.courseId}/sections`, { title }),
              )
            }
          >
            <label className="flex flex-1 flex-col gap-1 text-label">
              {s.sectionTitle}
              <input
                name="title"
                maxLength={120}
                required
                className="h-10 rounded-md border border-strong bg-surface px-3 font-normal"
              />
            </label>
            <Button type="submit" variant="primary" disabled={busy}>
              {s.addSection}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
