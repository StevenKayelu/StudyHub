'use client';

import type { LessonDetail, PeriodList } from '@studyhub/contracts';
import { Alert, Button, Checkbox, TextField } from '@studyhub/ui';
import type { JSONContent } from '@tiptap/react';
import { FileText, PlayCircle, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { type ApiResult, callApi, reloadTo, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { StudioTexts } from '../lib/studio-texts-type';
import { FileUpload } from './file-upload';
import { text, useApiForm } from './forms';
import { RichTextEditor } from './rich-text-editor';

/** The platform's document allowlist (DOCUMENT_TYPES; a school may allow fewer, and the API decides). */
const DOCUMENT_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.zip';

const formatSize = (bytes: number) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * S-T06/S-T07 Lesson editor: title, the content for its type (text, video or files), and the flags
 * (free preview, required, downloadable). Saves with the lesson's version; a stale version is reported.
 */
export function LessonEditor({
  courseId,
  initial,
  periods,
  editable,
  texts,
  quizzes = [],
  downloadPolicy = 'TUTOR_CHOOSES',
}: {
  courseId: string;
  initial: LessonDetail;
  periods: PeriodList['periods'];
  editable: boolean;
  texts: StudioTexts;
  /** QUIZ lessons: the course's quizzes to choose from. */
  quizzes?: { id: string; title: string; status: 'DRAFT' | 'READY' }[];
  /** Who decides downloads at this school (docs/design/content-protection.md). */
  downloadPolicy?: 'TUTOR_CHOOSES' | 'ALWAYS' | 'NEVER';
}) {
  const router = useRouter();
  const l = texts.studio.lesson;
  const form = useApiForm(texts.common);
  const [lesson, setLesson] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const content = useRef<JSONContent | null>(null);
  const path = `/api/v1/studio/courses/${courseId}/lessons/${lesson.id}`;

  async function patch(body: Record<string, unknown>): Promise<ApiResult<LessonDetail>> {
    const result = await callApi<LessonDetail>('PATCH', path, { version: lesson.version, ...body });
    if (result.ok) setLesson(result.data);
    return result;
  }

  async function patchNow(body: Record<string, unknown>) {
    setProblem(null);
    const result = await patch(body);
    if (!result.ok) {
      const split = splitProblem(result.problem, texts.common.networkError);
      setProblem(
        result.problem.code === 'VERSION_CONFLICT'
          ? texts.studio.outline.conflict
          : (split.summary ?? Object.values(split.fields)[0] ?? ''),
      );
    }
    router.refresh();
  }

  return (
    <div className="flex max-w-reading flex-col gap-6">
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={async (event) => {
          setSaved(false);
          const result = await form.submit(event, (data) =>
            patch({
              title: text(data, 'title'),
              ...(lesson.type === 'TEXT' && content.current !== null && { content: content.current }),
              isPreview: data.get('isPreview') === 'on',
              isRequired: data.get('isRequired') === 'on',
              ...(text(data, 'periodId') !== (lesson.period?.id ?? '') && {
                periodId: text(data, 'periodId') === '' ? null : text(data, 'periodId'),
              }),
              ...(lesson.type !== 'QUIZ' &&
                downloadPolicy === 'TUTOR_CHOOSES' && { downloadable: data.get('downloadable') === 'on' }),
            }),
          );
          if (result !== null) {
            setSaved(true);
            router.refresh();
          }
        }}
      >
        {form.feedback}
        {saved ? <Alert tone="success" role="status" title={texts.common.saved} /> : null}
        <fieldset disabled={!editable || form.busy} className="flex flex-col gap-5">
          <TextField
            id="title"
            name="title"
            label={l.title}
            defaultValue={lesson.title}
            maxLength={120}
            required
            error={form.fieldError('title')}
          />
          {lesson.type === 'TEXT' ? (
            <div className="flex flex-col gap-1">
              <span id="content-label" className="text-label text-ink">
                {l.content}
              </span>
              <RichTextEditor
                id="content"
                labelledBy="content-label"
                initial={lesson.content}
                invalid={form.fieldError('content') !== undefined}
                onChange={(doc) => {
                  content.current = doc;
                }}
                texts={texts.studio.editor}
              />
              {form.fieldError('content') !== undefined ? (
                <p className="text-body-sm text-danger">{form.fieldError('content')}</p>
              ) : null}
            </div>
          ) : null}
          {periods.length > 0 || lesson.period !== null ? (
            <label className="flex flex-col gap-1 text-label text-ink">
              {l.period}
              <select
                id="periodId"
                name="periodId"
                defaultValue={lesson.period?.id ?? ''}
                aria-describedby="periodId-hint"
                className="h-11 rounded-md border border-strong bg-surface px-3 text-body text-ink"
              >
                <option value="">{l.openTopic}</option>
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.name}
                  </option>
                ))}
                {lesson.period !== null && !periods.some((period) => period.id === lesson.period?.id) ? (
                  <option value={lesson.period.id}>
                    {lesson.period.name || texts.admin.periods.archived}
                  </option>
                ) : null}
              </select>
              <span id="periodId-hint" className="text-body-sm font-normal text-muted">
                {l.periodHint}
              </span>
              {form.fieldError('periodId') !== undefined ? (
                <span className="text-body-sm font-normal text-danger">{form.fieldError('periodId')}</span>
              ) : null}
            </label>
          ) : null}
          <Checkbox
            name="isPreview"
            label={l.isPreview}
            hint={l.isPreviewHint}
            defaultChecked={lesson.isPreview}
          />
          <Checkbox name="isRequired" label={l.isRequired} defaultChecked={lesson.isRequired} />
          {lesson.type !== 'QUIZ' ? (
            <Checkbox
              name="downloadable"
              label={l.downloadable}
              hint={
                downloadPolicy === 'ALWAYS'
                  ? l.downloadsAlways
                  : downloadPolicy === 'NEVER'
                    ? l.downloadsNever
                    : l.downloadableHint
              }
              disabled={downloadPolicy !== 'TUTOR_CHOOSES'}
              defaultChecked={
                downloadPolicy === 'TUTOR_CHOOSES' ? lesson.downloadable : downloadPolicy === 'ALWAYS'
              }
            />
          ) : null}
          <div>
            <Button type="submit" variant="primary">
              {texts.common.save}
            </Button>
          </div>
        </fieldset>
      </form>

      {problem !== null ? <Alert tone="danger" role="alert" title={problem} /> : null}

      {lesson.type === 'VIDEO' ? (
        <section aria-labelledby="video-heading" className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id="video-heading" className="text-h3">
            {l.video}
          </h2>
          {lesson.videoAssetId !== null ? (
            <p className="flex items-center gap-2" data-testid="lesson-video">
              <PlayCircle aria-hidden="true" className="size-5 text-success" />
              {texts.studio.upload.ready}
            </p>
          ) : null}
          <FileUpload
            purpose="LESSON_VIDEO"
            accept="video/mp4,video/webm,video/quicktime"
            label={l.uploadVideo}
            hint={l.videoHint}
            texts={texts}
            disabled={!editable}
            onReady={(asset) => patchNow({ videoAssetId: asset.id })}
          />
        </section>
      ) : null}

      {lesson.type === 'FILE' ? (
        <section aria-labelledby="files-heading" className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id="files-heading" className="text-h3">
            {l.files}
          </h2>
          {lesson.attachments.length > 0 ? (
            <ul
              className="flex flex-col divide-y divide-line rounded-md border border-line"
              data-testid="lesson-files"
            >
              {lesson.attachments.map((attachment) => (
                <li key={attachment.assetId} className="flex items-center gap-3 px-3 py-2">
                  <FileText aria-hidden="true" className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                  <span className="tabular text-caption text-muted">{formatSize(attachment.sizeBytes)}</span>
                  {editable ? (
                    <button
                      type="button"
                      className="inline-flex size-9 items-center justify-center rounded-sm text-muted hover:bg-sunken"
                      aria-label={`${texts.common.remove}: ${attachment.name}`}
                      onClick={() =>
                        void patchNow({
                          attachmentAssetIds: lesson.attachments
                            .map((item) => item.assetId)
                            .filter((id) => id !== attachment.assetId),
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <FileUpload
            purpose="LESSON_FILE"
            accept={DOCUMENT_ACCEPT}
            label={l.uploadFile}
            hint={l.filesHint}
            texts={texts}
            disabled={!editable || lesson.attachments.length >= 20}
            onReady={(asset) =>
              patchNow({ attachmentAssetIds: [...lesson.attachments.map((item) => item.assetId), asset.id] })
            }
          />
        </section>
      ) : null}

      {lesson.type === 'QUIZ' ? (
        <section className="flex flex-col gap-2" aria-labelledby="lesson-quiz">
          <h2 id="lesson-quiz" className="text-h3">
            {l.quiz}
          </h2>
          <p className="text-body-sm text-muted">{l.quizHint}</p>
          {quizzes.length === 0 ? (
            <p className="text-body-sm">{l.noQuizzes}</p>
          ) : (
            <label className="flex max-w-reading flex-col gap-1 text-label">
              {l.quiz}
              <select
                className="h-11 rounded-md border border-strong bg-surface px-3 font-normal"
                value={lesson.quizId ?? ''}
                disabled={!editable}
                onChange={(event) =>
                  void patchNow({ quizId: event.target.value === '' ? null : event.target.value })
                }
              >
                <option value="">{l.noQuiz}</option>
                {quizzes.map((quiz) => (
                  <option key={quiz.id} value={quiz.id}>
                    {quiz.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {quizzes.find((quiz) => quiz.id === lesson.quizId)?.status === 'DRAFT' ? (
            <Alert tone="warning">{l.quizDraft}</Alert>
          ) : null}
          <a href={`/studio/courses/${courseId}/quizzes`} className="self-start text-label">
            {l.manageQuizzes}
          </a>
        </section>
      ) : null}

      {editable ? (
        <div className="border-t border-line pt-5">
          <Button
            variant="ghost"
            onClick={async () => {
              if (!window.confirm(fill(l.deleteLessonConfirm, { title: lesson.title }))) return;
              const result = await callApi('DELETE', path);
              if (result.ok) reloadTo(`/studio/courses/${courseId}`);
              else setProblem(splitProblem(result.problem, texts.common.networkError).summary);
            }}
          >
            <Trash2 aria-hidden="true" className="size-4" />
            {l.deleteLesson}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
