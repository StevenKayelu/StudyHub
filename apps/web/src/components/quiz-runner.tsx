'use client';

import { type AnswerResponse, type AttemptView, formatMessage } from '@studyhub/contracts';
import { Alert, Banner, Button, Dialog, SaveIndicator } from '@studyhub/ui';
import { Flag, X } from 'lucide-react';
import NextLink from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { reloadTo } from '../lib/client-api';
import type { LearnTexts } from '../lib/learn-texts-type';
import { QuestionInput } from './question-input';

/** Answers kept on this device until the server has them (F19: offline answering, retried with backoff). */
interface Local {
  answers: Record<string, { response: AnswerResponse; seq: number; synced: boolean }>;
  flags: string[];
  submitQueued: boolean;
}

const storageKey = (attemptId: string) => `studyhub:attempt:${attemptId}`;

function readLocal(attemptId: string): Local | null {
  try {
    const raw = window.localStorage.getItem(storageKey(attemptId));
    return raw === null ? null : (JSON.parse(raw) as Local);
  } catch {
    return null;
  }
}

function writeLocal(attemptId: string, local: Local): void {
  try {
    window.localStorage.setItem(storageKey(attemptId), JSON.stringify(local));
  } catch {
    // Storage unavailable (private mode): answers still sync while online.
  }
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

type Outcome = { kind: 'ok' } | { kind: 'closed' } | { kind: 'retry'; afterMs: number } | { kind: 'gone' };

async function putAnswer(
  attemptId: string,
  itemId: string,
  response: AnswerResponse,
  seq: number,
): Promise<Outcome> {
  try {
    const res = await fetch(`/api/v1/learn/attempts/${attemptId}/answers/${itemId}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ response, clientSeq: seq }),
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 409) return { kind: 'closed' };
    if (res.status === 429)
      return { kind: 'retry', afterMs: Number(res.headers.get('retry-after') ?? '1') * 1000 };
    if (res.status === 404 || res.status === 422 || res.status === 403) return { kind: 'gone' };
    return { kind: 'retry', afterMs: 2000 };
  } catch {
    return { kind: 'retry', afterMs: 2000 };
  }
}

/**
 * S-L05 Focus mode. The server owns time: the countdown uses the server's clock offset, and at zero the
 * attempt is submitted (the server would auto-submit anyway, F19 AC 3). Every change is kept on the
 * device first and sent in order; offline, answers queue up ("3 unsynced") and go out on reconnect, and
 * a submit made offline is sent once the queue is empty. Nothing is discarded (S-L05 failure states).
 */
export function QuizRunner({
  attempt,
  texts,
  introHref,
}: {
  attempt: AttemptView;
  texts: LearnTexts;
  introHref: string;
}) {
  const r = texts.runner;
  const resultHref = `/learn/attempts/${attempt.id}/result`;
  const [local, setLocal] = useState<Local>(() => {
    const fromServer: Local['answers'] = Object.fromEntries(
      Object.entries(attempt.answers).map(([itemId, a]) => [
        itemId,
        { response: a.response, seq: a.clientSeq, synced: true },
      ]),
    );
    return { answers: fromServer, flags: [], submitQueued: false };
  });
  const localRef = useRef(local);
  localRef.current = local;
  const [index, setIndex] = useState(0);
  const [online, setOnline] = useState(true);
  const [failing, setFailing] = useState(false);
  const [closed, setClosed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unanswered' | 'flagged'>('all');
  const [submitting, setSubmitting] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const offset = useMemo(() => new Date(attempt.serverNow).getTime() - Date.now(), [attempt.serverNow]);
  const deadline = attempt.deadlineAt === null ? null : new Date(attempt.deadlineAt).getTime();
  const [remaining, setRemaining] = useState(deadline === null ? null : deadline - (Date.now() + offset));
  const flushing = useRef(false);

  // Merge what this device kept (newer sequence numbers win) once on mount.
  useEffect(() => {
    const kept = readLocal(attempt.id);
    if (kept === null) return;
    setLocal((current) => {
      const answers = { ...current.answers };
      for (const [itemId, entry] of Object.entries(kept.answers)) {
        if ((answers[itemId]?.seq ?? -1) < entry.seq) answers[itemId] = { ...entry, synced: false };
      }
      return { answers, flags: kept.flags, submitQueued: kept.submitQueued };
    });
  }, [attempt.id]);

  useEffect(() => writeLocal(attempt.id, local), [attempt.id, local]);

  const submitNow = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/learn/attempts/${attempt.id}/submit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (res.ok || res.status === 409) {
        try {
          window.localStorage.removeItem(storageKey(attempt.id));
        } catch {
          // ignore
        }
        reloadTo(resultHref);
        return true;
      }
    } catch {
      // offline: stays queued
    }
    setSubmitting(false);
    return false;
  }, [attempt.id, resultHref]);

  /** Sends unsynced answers one at a time, oldest change first; backs off on failure. */
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      let failures = 0;
      for (;;) {
        const pending = Object.entries(localRef.current.answers).find(([, a]) => !a.synced);
        if (pending === undefined) break;
        const [itemId, entry] = pending;
        const outcome = await putAnswer(attempt.id, itemId, entry.response, entry.seq);
        if (outcome.kind === 'ok' || outcome.kind === 'gone') {
          failures = 0;
          setFailing(false);
          setLocal((current) => {
            const now = current.answers[itemId];
            if (now === undefined || now.seq !== entry.seq) return current; // changed meanwhile: send again
            return { ...current, answers: { ...current.answers, [itemId]: { ...now, synced: true } } };
          });
          localRef.current = {
            ...localRef.current,
            answers: {
              ...localRef.current.answers,
              ...(localRef.current.answers[itemId]?.seq === entry.seq && {
                [itemId]: { ...entry, synced: true },
              }),
            },
          };
          continue;
        }
        if (outcome.kind === 'closed') {
          setClosed(true);
          break;
        }
        failures += 1;
        if (failures >= 3) setFailing(true);
        if (!navigator.onLine) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(30_000, outcome.afterMs * 2 ** Math.max(0, failures - 1))),
        );
      }
    } finally {
      flushing.current = false;
    }
    const synced = Object.values(localRef.current.answers).every((a) => a.synced);
    if (synced && localRef.current.submitQueued && navigator.onLine) await submitNow();
  }, [attempt.id, submitNow]);

  // Debounced autosave after each change.
  useEffect(() => {
    if (Object.values(local.answers).every((a) => a.synced)) return;
    const timer = window.setTimeout(() => void flush(), 600);
    return () => window.clearTimeout(timer);
  }, [local.answers, flush]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => {
      setOnline(true);
      void flush();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [flush]);

  // The countdown (server time). At zero: "Time's up — submitting your answers".
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => {
      const left = deadline - (Date.now() + offset);
      setRemaining(left);
      if (left <= 0) {
        window.clearInterval(timer);
        setTimeUp(true);
        setLocal((current) => ({ ...current, submitQueued: true }));
        localRef.current = { ...localRef.current, submitQueued: true };
        void flush().then(() => {
          // The server has (or will have) submitted it: show the result either way.
          if (Object.values(localRef.current.answers).every((a) => a.synced)) void submitNow();
        });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline, offset, flush, submitNow]);

  useEffect(() => {
    if (closed) reloadTo(resultHref);
  }, [closed, resultHref]);

  const items = attempt.items;
  const item = items[index]!;
  const answered = (itemId: string) => {
    const a = local.answers[itemId]?.response;
    if (a === undefined) return false;
    if ('optionIds' in a) return a.optionIds.length > 0;
    if ('text' in a) return a.text.trim() !== '';
    return true;
  };
  const unsynced = Object.values(local.answers).filter((a) => !a.synced).length;
  const answeredCount = items.filter((i) => answered(i.id)).length;
  const flagged = new Set(local.flags);

  const setAnswer = (itemId: string, response: AnswerResponse) =>
    setLocal((current) => ({
      ...current,
      answers: {
        ...current.answers,
        [itemId]: { response, seq: (current.answers[itemId]?.seq ?? 0) + 1, synced: false },
      },
    }));

  const requestSubmit = async () => {
    setLocal((current) => ({ ...current, submitQueued: true }));
    localRef.current = { ...localRef.current, submitQueued: true };
    if (!navigator.onLine) return;
    await flush();
  };

  const warning = remaining !== null && remaining < 60_000;
  const danger = remaining !== null && remaining < 15_000;
  const share =
    deadline === null || remaining === null
      ? 1
      : Math.max(0, remaining) / (deadline - new Date(attempt.startedAt).getTime());
  const visible = items
    .map((i, n) => ({ i, n }))
    .filter(({ i }) =>
      filter === 'unanswered' ? !answered(i.id) : filter === 'flagged' ? flagged.has(i.id) : true,
    );

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        {deadline !== null ? (
          <div className="h-1 w-full bg-sunken" aria-hidden="true">
            <div
              className={`h-full ${danger ? 'bg-danger' : warning ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        ) : null}
        <div className="mx-auto flex max-w-reading items-center gap-3 px-4 py-2">
          <p className="min-w-0 flex-1 truncate text-label">{attempt.title}</p>
          {remaining !== null ? (
            <p
              className={`tabular text-label ${danger ? 'text-danger' : warning ? 'text-warning' : ''}`}
              data-testid="time-left"
            >
              {formatMessage(r.timeLeft, { time: clock(remaining) })}
            </p>
          ) : null}
          <span data-testid="save-state">
            {unsynced > 0 ? (
              <span className="text-caption text-muted">
                {formatMessage(r.unsynced, { count: unsynced })}
              </span>
            ) : (
              <SaveIndicator state="saved" label={r.saved} />
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setNavOpen(true)}>
            {r.navigator}
          </Button>
          <NextLink
            href={introHref}
            className="flex min-h-11 items-center gap-1 text-label no-underline"
            title={r.exitHint}
          >
            <X aria-hidden="true" className="size-4" />
            {r.exit}
          </NextLink>
        </div>
      </header>
      {!online ? <Banner tone="warning">{r.offline}</Banner> : null}
      {failing && online ? <Banner tone="danger">{r.saveFailed}</Banner> : null}
      {local.submitQueued && !online ? <Banner tone="info">{r.submitQueued}</Banner> : null}

      <main id="content" className="mx-auto flex w-full max-w-reading flex-1 flex-col gap-6 px-4 py-6">
        <p className="text-caption text-muted">
          {formatMessage(r.questionOf, { number: index + 1, total: items.length })} ·{' '}
          {formatMessage(r.points, { count: item.points })}
        </p>
        <QuestionInput
          key={item.id}
          question={item.question}
          value={local.answers[item.id]?.response ?? null}
          onChange={(response) => setAnswer(item.id, response)}
          texts={texts}
          disabled={timeUp || closed}
          heading={formatMessage(r.questionOf, { number: index + 1, total: items.length })}
        />
      </main>

      <footer className="sticky bottom-0 border-t border-line bg-surface">
        <div className="mx-auto flex max-w-reading items-center gap-2 px-4 py-3">
          <Button variant="ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            {r.previous}
          </Button>
          <Button
            variant="ghost"
            aria-pressed={flagged.has(item.id)}
            icon={<Flag aria-hidden="true" className="size-4" />}
            onClick={() =>
              setLocal((current) => ({
                ...current,
                flags: flagged.has(item.id)
                  ? current.flags.filter((f) => f !== item.id)
                  : [...current.flags, item.id],
              }))
            }
          >
            {flagged.has(item.id) ? r.unflag : r.flag}
          </Button>
          <span className="flex-1" />
          {index < items.length - 1 ? (
            <Button variant="primary" onClick={() => setIndex(index + 1)}>
              {r.next}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setReviewOpen(true)}>
              {r.reviewSubmit}
            </Button>
          )}
        </div>
      </footer>

      <Dialog open={navOpen} onOpenChange={setNavOpen} title={r.navigator} closeLabel={texts.common.close}>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2" role="group" aria-label={r.navigator}>
            {(['all', 'unanswered', 'flagged'] as const).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={filter === key ? 'secondary' : 'ghost'}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key === 'all' ? r.all : key === 'unanswered' ? r.unansweredOnly : r.flaggedOnly}
              </Button>
            ))}
          </div>
          <ol className="grid grid-cols-5 gap-2">
            {visible.map(({ i, n }) => (
              <li key={i.id}>
                <button
                  type="button"
                  aria-current={n === index ? 'step' : undefined}
                  aria-label={`${formatMessage(r.questionOf, { number: n + 1, total: items.length })}${answered(i.id) ? '' : `, ${formatMessage(r.unanswered, { count: 1 })}`}${flagged.has(i.id) ? `, ${r.flag}` : ''}`}
                  onClick={() => {
                    setIndex(n);
                    setNavOpen(false);
                  }}
                  className={`tabular relative flex h-11 w-full items-center justify-center rounded-md border text-label ${
                    n === index ? 'border-accent' : 'border-line'
                  } ${answered(i.id) ? 'bg-accent-soft' : 'bg-surface'}`}
                >
                  {n + 1}
                  {flagged.has(i.id) ? (
                    <Flag aria-hidden="true" className="absolute right-1 top-1 size-3 text-warning" />
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </div>
      </Dialog>

      <Dialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        title={r.summary}
        closeLabel={texts.common.close}
      >
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1 text-body">
            <li>{formatMessage(r.answered, { count: answeredCount })}</li>
            <li>{formatMessage(r.unanswered, { count: items.length - answeredCount })}</li>
            <li>{formatMessage(r.flagged, { count: flagged.size })}</li>
          </ul>
          {items.length - answeredCount > 0 ? (
            <Alert tone="warning">{r.confirmSubmitUnanswered}</Alert>
          ) : (
            <p>{r.confirmSubmit}</p>
          )}
          {local.submitQueued && !online ? <Alert tone="info">{r.submitQueued}</Alert> : null}
          <Button variant="primary" disabled={submitting} onClick={() => void requestSubmit()}>
            {submitting ? r.submitting : r.submit}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={timeUp}
        onOpenChange={() => undefined}
        title={r.timeUp}
        closeLabel={texts.common.close}
        preventClose
      >
        <p role="status">{r.submitting}</p>
      </Dialog>
    </div>
  );
}
