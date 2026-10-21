'use client';

import type { CategoryTree, PeriodList, StudioCourse } from '@studyhub/contracts';
import { Alert, Button, TextArea, TextField } from '@studyhub/ui';
import type { JSONContent } from '@tiptap/react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { callApi } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';
import { FileUpload } from './file-upload';
import { text, useApiForm } from './forms';
import { RichTextEditor } from './rich-text-editor';

const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS'] as const;
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const selectClasses = 'h-11 rounded-md border border-strong bg-surface px-3 text-body text-ink';

/** S-T04 Course details: title, description, outcomes, level, subject, tags and the cover image. */
export function CourseDetailsForm({
  course,
  categories,
  periods,
  editable,
  texts,
}: {
  course: StudioCourse;
  categories: CategoryTree['categories'];
  /** The school's current terms and semesters (docs/design/course-periods.md). */
  periods: PeriodList['periods'];
  editable: boolean;
  texts: StudioTexts;
}) {
  const router = useRouter();
  const d = texts.studio.details;
  const form = useApiForm(texts.common);
  const [version, setVersion] = useState(course.version);
  const [coverUrl, setCoverUrl] = useState(course.coverUrl);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const description = useRef<JSONContent | null>(null);

  async function patch(body: Record<string, unknown>) {
    const result = await callApi<StudioCourse>('PATCH', `/api/v1/studio/courses/${course.id}`, {
      version,
      ...body,
    });
    if (result.ok) {
      setVersion(result.data.version);
      setCoverUrl(result.data.coverUrl);
    } else if (result.problem.code === 'VERSION_CONFLICT') {
      setConflict(true);
    }
    return result;
  }

  return (
    <form
      noValidate
      className="flex max-w-reading flex-col gap-5"
      onSubmit={async (event) => {
        setSaved(false);
        const result = await form.submit(event, (data) =>
          patch({
            title: text(data, 'title'),
            subtitle: text(data, 'subtitle').trim() === '' ? null : text(data, 'subtitle'),
            ...(description.current !== null && { description: description.current }),
            outcomes: lines(text(data, 'outcomes')),
            requirements: lines(text(data, 'requirements')),
            level: text(data, 'level'),
            subjectId: text(data, 'subjectId') === '' ? null : text(data, 'subjectId'),
            // Sent only when changed, so a course in an archived term keeps it.
            ...(text(data, 'periodId') !== (course.periodId ?? '') && {
              periodId: text(data, 'periodId') === '' ? null : text(data, 'periodId'),
            }),
            tags: text(data, 'tags')
              .split(',')
              .map((tag) => tag.trim().toLowerCase())
              .filter((tag) => tag !== ''),
          }),
        );
        if (result !== null) {
          setSaved(true);
          router.refresh();
        }
      }}
    >
      {conflict ? (
        <Alert
          tone="warning"
          role="alert"
          title={texts.studio.outline.conflict}
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => window.location.reload()}>
              {texts.common.back}
            </Button>
          }
        />
      ) : null}
      {form.feedback}
      {saved ? <Alert tone="success" role="status" title={texts.common.saved} /> : null}
      <fieldset disabled={!editable || form.busy} className="flex flex-col gap-5">
        <TextField
          id="title"
          name="title"
          label={texts.studio.courseTitle}
          defaultValue={course.title}
          maxLength={120}
          required
          error={form.fieldError('title')}
        />
        <TextField
          id="subtitle"
          name="subtitle"
          label={d.subtitle}
          defaultValue={course.subtitle ?? ''}
          maxLength={200}
          error={form.fieldError('subtitle')}
        />
        <div className="flex flex-col gap-1">
          <span id="description-label" className="text-label text-ink">
            {d.description}
          </span>
          <p id="description-hint" className="text-body-sm text-muted">
            {d.descriptionHint}
          </p>
          <RichTextEditor
            id="description"
            labelledBy="description-label"
            describedBy="description-hint"
            initial={course.description}
            invalid={form.fieldError('description') !== undefined}
            onChange={(doc) => {
              description.current = doc;
            }}
            texts={texts.studio.editor}
          />
          {form.fieldError('description') !== undefined ? (
            <p className="text-body-sm text-danger">{form.fieldError('description')}</p>
          ) : null}
        </div>
        <TextArea
          id="outcomes"
          name="outcomes"
          label={d.outcomes}
          hint={d.outcomesHint}
          rows={5}
          defaultValue={course.outcomes.join('\n')}
          error={form.fieldError('outcomes')}
        />
        <TextArea
          id="requirements"
          name="requirements"
          label={d.requirements}
          hint={d.requirementsHint}
          rows={3}
          defaultValue={course.requirements.join('\n')}
          error={form.fieldError('requirements')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-label text-ink">
            {d.level}
            <select id="level" name="level" defaultValue={course.level} className={selectClasses}>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {texts.levels[level]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-label text-ink">
            {d.subject}
            <select
              id="subjectId"
              name="subjectId"
              defaultValue={course.subjectId ?? ''}
              className={selectClasses}
            >
              <option value="">{d.chooseSubject}</option>
              {categories.map((category) => (
                <optgroup key={category.id} label={category.name}>
                  {category.subjects.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {form.fieldError('subjectId') !== undefined ? (
              <span className="text-body-sm font-normal text-danger">{form.fieldError('subjectId')}</span>
            ) : null}
          </label>
        </div>
        {periods.length > 0 || course.periodId !== null ? (
          <label className="flex flex-col gap-1 text-label text-ink">
            {d.period}
            <select
              id="periodId"
              name="periodId"
              defaultValue={course.periodId ?? ''}
              aria-describedby="periodId-hint"
              className={selectClasses}
            >
              <option value="">{d.openCourse}</option>
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name}
                </option>
              ))}
              {course.periodId !== null && !periods.some((period) => period.id === course.periodId) ? (
                <option value={course.periodId}>
                  {course.lock?.periodName ?? texts.admin.periods.archived}
                </option>
              ) : null}
            </select>
            <span id="periodId-hint" className="text-body-sm font-normal text-muted">
              {course.accessOverride === 'LOCKED'
                ? d.lockedByAdmin
                : course.accessOverride === 'OPEN'
                  ? d.openedByAdmin
                  : d.periodHint}
            </span>
            {form.fieldError('periodId') !== undefined ? (
              <span className="text-body-sm font-normal text-danger">{form.fieldError('periodId')}</span>
            ) : null}
          </label>
        ) : null}
        <TextField
          id="tags"
          name="tags"
          label={d.tags}
          hint={d.tagsHint}
          defaultValue={course.tags.join(', ')}
          error={form.fieldError('tags')}
        />
        <div>
          <Button type="submit" variant="primary">
            {texts.common.save}
          </Button>
        </div>
      </fieldset>

      <section aria-labelledby="cover-heading" className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 id="cover-heading" className="text-h3">
          {d.cover}
        </h2>
        <div className="aspect-video w-full max-w-sm overflow-hidden rounded-md border border-line bg-sunken">
          {coverUrl !== null ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed object-storage URL
            <img src={coverUrl} alt="" className="h-full w-full object-cover" data-testid="cover-preview" />
          ) : null}
        </div>
        <FileUpload
          purpose="COURSE_COVER"
          accept="image/jpeg,image/png,image/webp"
          label={d.uploadCover}
          hint={d.coverHint}
          texts={texts}
          disabled={!editable}
          onReady={async (asset) => {
            await patch({ coverAssetId: asset.id });
            router.refresh();
          }}
        />
      </section>
    </form>
  );
}
