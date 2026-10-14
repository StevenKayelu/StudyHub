'use client';

import type { AssetStatus } from '@studyhub/contracts';
import { buttonClasses } from '@studyhub/ui';
import { CircleAlert, CircleCheck, LoaderCircle, Upload } from 'lucide-react';
import { useId, useState } from 'react';

import { fill } from '../lib/fill';
import type { StudioTexts } from '../lib/studio-texts-type';
import { type UploadPhase, uploadFile } from '../lib/upload';

/**
 * File picker that uploads straight to storage and reports progress in words (06 §2.7): uploading,
 * checking (verification and malware scan), ready, or why it was refused.
 */
export function FileUpload({
  purpose,
  accept,
  label,
  hint,
  texts,
  disabled = false,
  onReady,
}: {
  purpose: 'COURSE_COVER' | 'LESSON_FILE' | 'LESSON_VIDEO';
  accept: string;
  label: string;
  hint?: string;
  texts: StudioTexts;
  disabled?: boolean;
  onReady: (asset: AssetStatus) => void | Promise<void>;
}) {
  const id = useId();
  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const u = texts.studio.upload;
  const working = phase === 'uploading' || phase === 'checking';

  const status =
    phase === 'uploading'
      ? u.uploading
      : phase === 'checking'
        ? u.checking
        : phase === 'ready'
          ? u.ready
          : phase === 'rejected'
            ? fill(u.rejected, { reason: detail ?? '' })
            : phase === 'failed'
              ? (detail ?? u.failed)
              : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={id}
          className={
            buttonClasses('secondary', 'md') +
            (working || disabled ? ' pointer-events-none opacity-50' : ' cursor-pointer')
          }
        >
          <Upload aria-hidden="true" className="size-4" />
          {label}
        </label>
        <input
          id={id}
          type="file"
          accept={accept}
          className="sr-only"
          disabled={working || disabled}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file === undefined) return;
            setDetail(undefined);
            const asset = await uploadFile(file, purpose, (next, info) => {
              setPhase(next);
              setDetail(info);
            });
            if (asset?.status === 'READY') await onReady(asset);
          }}
        />
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-body-sm">
          {working ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted" /> : null}
          {phase === 'ready' ? <CircleCheck aria-hidden="true" className="size-4 text-success" /> : null}
          {phase === 'rejected' || phase === 'failed' ? (
            <CircleAlert aria-hidden="true" className="size-4 text-danger" />
          ) : null}
          {status}
        </span>
      </div>
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-body-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
