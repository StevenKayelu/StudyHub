'use client';

import type { PlayerLesson, ProgressResult } from '@studyhub/contracts';
import { Alert, Button, buttonClasses } from '@studyhub/ui';
import { CircleCheck, Download, Eye, Pause, Play, RotateCcw, RotateCw, X } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { callApi } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { LearnTexts } from '../lib/learn-texts-type';
import { ProtectedContent, Watermark } from './protected-content';

/** Seconds of playback between automatic saves (F15 AC 1). */
const SAVE_EVERY_SECONDS = 15;

type Progress = { status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'; positionSeconds: number };

export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Saves progress for one lesson. `keepalive` lets the last save finish while the page is being left
 * (pagehide, switching lessons), so the resume point is never more than a few seconds behind.
 */
async function sendProgress(
  lessonId: string,
  body: { status?: 'IN_PROGRESS' | 'COMPLETED'; positionSeconds?: number },
  keepalive = false,
): Promise<ProgressResult | null> {
  if (keepalive) {
    try {
      await fetch(`/api/v1/learn/lessons/${lessonId}/progress`, {
        method: 'PUT',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Leaving the page: nothing more to do.
    }
    return null;
  }
  const result = await callApi<ProgressResult>('PUT', `/api/v1/learn/lessons/${lessonId}/progress`, body);
  return result.ok ? result.data : null;
}

/**
 * S-L02 lesson body and bottom action bar. The lesson's content is rendered on the server and passed
 * in as children; this component adds the video player, file downloads, "Mark complete", previous and
 * next (also with ← and →), and saves progress for enrolled learners.
 */
export function LessonPlayer({
  lesson,
  canSave,
  texts,
  courseHref,
  completeHref,
  children,
}: {
  lesson: PlayerLesson;
  /** Enrolled learner in an active school: progress is recorded. */
  canSave: boolean;
  texts: LearnTexts;
  courseHref: string;
  completeHref: string;
  children: ReactNode;
}) {
  const p = texts.player;
  const router = useRouter();
  const [progress, setProgress] = useState<Progress>(
    lesson.progress ?? { status: 'NOT_STARTED', positionSeconds: 0 },
  );
  const status = useRef(progress.status);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const lessonHref = (id: string) => `${courseHref}/lessons/${id}`;

  const apply = useCallback(
    (result: ProgressResult | null) => {
      if (result === null) {
        setSaveFailed(true);
        return;
      }
      setSaveFailed(false);
      const justCompleted = status.current !== 'COMPLETED' && result.lesson.status === 'COMPLETED';
      status.current = result.lesson.status;
      setProgress(result.lesson);
      if (result.completedNow) {
        // Straight to the completion screen (a refresh now could cancel this navigation).
        router.push(completeHref);
      } else if (justCompleted) {
        setAnnouncement(p.lessonComplete);
        // The outline and the progress line come from the server: refresh them.
        router.refresh();
      }
    },
    [completeHref, p.lessonComplete, router],
  );

  const save = useCallback(
    async (body: { status?: 'IN_PROGRESS' | 'COMPLETED'; positionSeconds?: number }) => {
      if (!canSave) return;
      apply(await sendProgress(lesson.id, body));
    },
    [apply, canSave, lesson.id],
  );

  // Opening a lesson makes it the resume point (status only: a saved video position is kept). Once per
  // lesson: the component is keyed by lesson id.
  const opened = useRef(false);
  useEffect(() => {
    if (!canSave || opened.current) return;
    opened.current = true;
    void sendProgress(lesson.id, { status: 'IN_PROGRESS' }).then(apply);
  }, [apply, canSave, lesson.id]);

  // ← / → move between lessons when focus isn't in a field or a slider (S-L02).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
      const to =
        event.key === 'ArrowLeft' ? lesson.previous : event.key === 'ArrowRight' ? lesson.next : null;
      if (to === null) return;
      event.preventDefault();
      router.push(lessonHref(to.id));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const completed = progress.status === 'COMPLETED';
  const videoKnownLength =
    lesson.type === 'VIDEO' && lesson.durationSeconds !== null && lesson.durationSeconds > 0;
  const manualComplete =
    lesson.type === 'TEXT' || lesson.type === 'FILE' || (lesson.type === 'VIDEO' && !videoKnownLength);

  const body = (
    <div className="flex flex-col gap-6">
      {lesson.type === 'VIDEO' ? (
        <VideoPlayer
          lesson={lesson}
          texts={texts}
          startAt={progress.positionSeconds}
          canSave={canSave}
          onSave={(positionSeconds, keepalive) => {
            if (!canSave) return;
            if (keepalive) void sendProgress(lesson.id, { positionSeconds }, true);
            else void save({ positionSeconds });
          }}
        />
      ) : null}

      {children}

      {lesson.video?.downloadable === true ? <SaveVideo lessonId={lesson.id} texts={texts} /> : null}

      {lesson.attachments.length > 0 ? <FileList lesson={lesson} texts={texts} /> : null}

      {lesson.type === 'QUIZ' && lesson.quizId !== null && lesson.access !== 'PREVIEW' ? (
        <NextLink
          href={`/learn/quizzes/${lesson.quizId}`}
          className={`${buttonClasses('primary')} self-start`}
        >
          {p.takeQuiz}
        </NextLink>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {saveFailed ? <Alert tone="warning">{p.saveFailed}</Alert> : null}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:rounded-md md:border">
        {completed ? (
          <span className="flex items-center gap-2 text-label text-success" data-testid="lesson-state">
            <CircleCheck aria-hidden="true" className="size-5" />
            {p.completed}
          </span>
        ) : canSave && manualComplete ? (
          <Button
            variant="secondary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await save({ status: 'COMPLETED' });
              setSaving(false);
            }}
          >
            {saving ? p.marking : p.markComplete}
          </Button>
        ) : canSave && lesson.type === 'VIDEO' ? (
          <span className="text-body-sm text-muted" data-testid="lesson-state">
            {fill(p.autoComplete, { percent: lesson.completionThresholdPct })}
          </span>
        ) : null}
        <span className="flex-1" />
        {lesson.previous !== null ? (
          <NextLink href={lessonHref(lesson.previous.id)} className={buttonClasses('ghost')}>
            {p.previous}
          </NextLink>
        ) : null}
        {lesson.next !== null ? (
          <NextLink href={lessonHref(lesson.next.id)} className={buttonClasses('primary')} rel="next">
            {fill(p.next, { title: lesson.next.title })}
          </NextLink>
        ) : null}
      </div>
    </div>
  );
  return lesson.protection === null ? (
    body
  ) : (
    <ProtectedContent watermark={lesson.protection.watermark} notice={p.protectedNotice}>
      {body}
    </ProtectedContent>
  );
}

/** Saves the video for offline viewing, where the lesson allows downloads (content-protection.md). */
function SaveVideo({ lessonId, texts }: { lessonId: string; texts: LearnTexts }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {failed ? <Alert tone="danger">{texts.player.downloadFailed}</Alert> : null}
      <Button
        variant="secondary"
        className="self-start"
        icon={<Download aria-hidden="true" className="size-4" />}
        onClick={async () => {
          setFailed(false);
          const result = await callApi<{ url: string }>(
            'GET',
            `/api/v1/learn/lessons/${lessonId}/video/download`,
          );
          if (result.ok) window.location.assign(result.data.url);
          else setFailed(true);
        }}
      >
        {texts.player.saveVideo}
      </Button>
    </div>
  );
}

/** Files a browser opens by itself, so a stream-and-view-only lesson can still show them. */
const viewable = (mime: string) => mime === 'application/pdf' || mime.startsWith('image/');

/**
 * Lesson files: Download where the lesson allows it, else View (PDFs and images, in the page, with the
 * watermark when protected). Links are fresh per click and short-lived, so they're never in the page.
 */
function FileList({ lesson, texts }: { lesson: PlayerLesson; texts: LearnTexts }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{ name: string; mime: string; url: string } | null>(null);
  return (
    <section aria-labelledby="files" className="flex flex-col gap-2">
      <h2 id="files" className="text-h3">
        {texts.player.attachments}
      </h2>
      {!lesson.downloadable ? <p className="text-body-sm text-muted">{texts.player.viewOnly}</p> : null}
      {failed ? <Alert tone="danger">{texts.player.downloadFailed}</Alert> : null}
      {open !== null ? (
        <div className="flex flex-col gap-2" data-testid="file-viewer">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-label">{open.name}</p>
            <Button
              size="sm"
              variant="ghost"
              icon={<X aria-hidden="true" className="size-4" />}
              onClick={() => setOpen(null)}
            >
              {texts.player.closeViewer}
            </Button>
          </div>
          <div className="relative h-[70vh] overflow-hidden rounded-md border border-line bg-surface">
            {open.mime === 'application/pdf' ? (
              <iframe title={open.name} src={`${open.url}#toolbar=0&navpanes=0`} className="h-full w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL
              <img src={open.url} alt={open.name} className="h-full w-full object-contain" />
            )}
            {lesson.protection !== null ? <Watermark text={lesson.protection.watermark} /> : null}
          </div>
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {lesson.attachments.map((file) => (
          <li key={file.assetId} className="flex items-center gap-3 p-3">
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="tabular text-caption text-muted">
              {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
            </span>
            {lesson.downloadable ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Download aria-hidden="true" className="size-4" />}
                aria-label={fill(texts.player.downloadName, { name: file.name })}
                onClick={async () => {
                  setFailed(false);
                  const result = await callApi<{ url: string }>(
                    'GET',
                    `/api/v1/learn/lessons/${lesson.id}/files/${file.assetId}/url`,
                  );
                  if (result.ok) window.location.assign(result.data.url);
                  else setFailed(true);
                }}
              >
                {texts.player.download}
              </Button>
            ) : viewable(file.mime) ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Eye aria-hidden="true" className="size-4" />}
                aria-label={fill(texts.player.viewName, { name: file.name })}
                onClick={async () => {
                  setFailed(false);
                  const result = await callApi<{ url: string }>(
                    'GET',
                    `/api/v1/learn/lessons/${lesson.id}/files/${file.assetId}/url?mode=view`,
                  );
                  if (result.ok) setOpen({ name: file.name, mime: file.mime, url: result.data.url });
                  else setFailed(true);
                }}
              >
                {texts.player.view}
              </Button>
            ) : (
              <span className="text-caption text-muted">{texts.player.notViewable}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type PlaybackInfo = { kind: 'hls' | 'mp4' | 'simulated'; url: string | null; durationSeconds: number | null };

/**
 * Video lessons (F15). Saves the position every 15 s of playback, and on pause, seek, the end, leaving
 * the page and switching lessons, so the resume point is within a few seconds (07 M6 AC 2).
 */
function VideoPlayer({
  lesson,
  texts,
  startAt,
  canSave,
  onSave,
}: {
  lesson: PlayerLesson;
  texts: LearnTexts;
  startAt: number;
  canSave: boolean;
  onSave: (positionSeconds: number, keepalive: boolean) => void;
}) {
  const [playback, setPlayback] = useState<PlaybackInfo | 'error' | null>(null);
  const position = useRef(startAt);
  const sinceSave = useRef(0);
  const dirty = useRef(false);

  useEffect(() => {
    if (lesson.video?.status !== 'READY') return;
    let cancelled = false;
    void callApi<PlaybackInfo>('GET', `/api/v1/learn/lessons/${lesson.id}/playback`).then((result) => {
      if (!cancelled) setPlayback(result.ok ? result.data : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [lesson.id, lesson.video?.status]);

  const flush = useCallback(
    (keepalive: boolean) => {
      if (!dirty.current) return;
      dirty.current = false;
      sinceSave.current = 0;
      onSave(Math.floor(position.current), keepalive);
    },
    [onSave],
  );

  // Leaving the page or the lesson: one last save that survives the navigation.
  useEffect(() => {
    if (!canSave) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush(true);
    };
    const onPageHide = () => flush(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      flush(true);
    };
  }, [canSave, flush]);

  const events = {
    /** Called while playing with the seconds just played. */
    onTick(current: number, played: number) {
      position.current = current;
      dirty.current = true;
      sinceSave.current += played;
      if (sinceSave.current >= SAVE_EVERY_SECONDS) flush(false);
    },
    onPause(current: number) {
      position.current = current;
      dirty.current = true;
      flush(false);
    },
    onSeek(current: number) {
      position.current = current;
      dirty.current = true;
      flush(false);
    },
  };

  if (lesson.video === null || lesson.video.status === 'REJECTED' || playback === 'error') {
    return <Alert tone="warning">{texts.player.videoUnavailable}</Alert>;
  }
  if (lesson.video.status !== 'READY') return <Alert tone="info">{texts.player.videoProcessing}</Alert>;
  if (playback === null) return <div className="aspect-video w-full animate-pulse rounded-md bg-sunken" />;
  const duration = playback.durationSeconds ?? lesson.durationSeconds ?? 0;
  if (playback.kind === 'simulated' || playback.url === null) {
    return <SimulatedVideo duration={duration} startAt={startAt} texts={texts} {...events} />;
  }
  return <NativeVideo url={playback.url} startAt={startAt} {...events} />;
}

function NativeVideo({
  url,
  startAt,
  onTick,
  onPause,
  onSeek,
}: {
  url: string;
  startAt: number;
  onTick: (current: number, played: number) => void;
  onPause: (current: number) => void;
  onSeek: (current: number) => void;
}) {
  const last = useRef(startAt);
  return (
    <video
      src={url}
      controls
      playsInline
      preload="metadata"
      className="aspect-video w-full rounded-md bg-black"
      onLoadedMetadata={(event) => {
        if (startAt > 0) event.currentTarget.currentTime = startAt;
      }}
      onTimeUpdate={(event) => {
        const current = event.currentTarget.currentTime;
        const played = current - last.current;
        last.current = current;
        if (played > 0 && played < 2 && !event.currentTarget.seeking) onTick(current, played);
      }}
      onPause={(event) => onPause(event.currentTarget.currentTime)}
      onEnded={(event) => onPause(event.currentTarget.currentTime)}
      onSeeked={(event) => {
        last.current = event.currentTarget.currentTime;
        onSeek(event.currentTarget.currentTime);
      }}
    />
  );
}

/**
 * The development provider keeps no video bytes (PROPOSED 9): a clearly labelled timer as long as the
 * video, with the usual controls, so progress, completion and resume work end to end.
 */
function SimulatedVideo({
  duration,
  startAt,
  texts,
  onTick,
  onPause,
  onSeek,
}: {
  duration: number;
  startAt: number;
  texts: LearnTexts;
  onTick: (current: number, played: number) => void;
  onPause: (current: number) => void;
  onSeek: (current: number) => void;
}) {
  const v = texts.video;
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(Math.min(startAt, duration));
  const currentRef = useRef(current);

  useEffect(() => {
    if (!playing) return;
    const step = 0.25;
    const timer = window.setInterval(() => {
      const next = Math.min(currentRef.current + step, duration);
      currentRef.current = next;
      setCurrent(next);
      onTick(next, step);
      if (next >= duration) {
        setPlaying(false);
        onPause(next);
      }
    }, step * 1000);
    return () => window.clearInterval(timer);
  }, [duration, onPause, onTick, playing]);

  const seek = (to: number) => {
    const next = Math.min(Math.max(to, 0), duration);
    currentRef.current = next;
    setCurrent(next);
    onSeek(next);
  };

  return (
    <figure
      className="flex flex-col gap-3 rounded-md border border-line bg-sunken p-4"
      data-testid="simulated-video"
    >
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md bg-accent text-center text-on-accent">
        <span className="text-h3">{v.simulated}</span>
        <span className="tabular text-body-lg" aria-hidden="true">
          {fill(v.time, { current: formatClock(current), total: formatClock(duration) })}
        </span>
      </div>
      <figcaption className="text-caption text-muted">{v.simulatedHint}</figcaption>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={
            playing ? (
              <Pause aria-hidden="true" className="size-4" />
            ) : (
              <Play aria-hidden="true" className="size-4" />
            )
          }
          onClick={() => {
            if (playing) {
              setPlaying(false);
              onPause(currentRef.current);
            } else {
              if (currentRef.current >= duration) seek(0);
              setPlaying(true);
            }
          }}
        >
          {playing ? v.pause : v.play}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={v.back}
          icon={<RotateCcw aria-hidden="true" className="size-4" />}
          onClick={() => seek(currentRef.current - 10)}
        />
        <Button
          size="sm"
          variant="ghost"
          aria-label={v.forward}
          icon={<RotateCw aria-hidden="true" className="size-4" />}
          onClick={() => seek(currentRef.current + 10)}
        />
        <label className="flex min-w-40 flex-1 items-center gap-2 text-caption text-muted">
          <span className="sr-only">{v.position}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1}
            value={Math.floor(current)}
            aria-valuetext={fill(v.time, { current: formatClock(current), total: formatClock(duration) })}
            onChange={(event) => seek(Number(event.target.value))}
            className="h-11 flex-1 accent-[var(--color-accent)]"
          />
          <span className="tabular">{formatClock(current)}</span>
        </label>
      </div>
    </figure>
  );
}
