'use client';

import type { AssetStatus, UploadSlot } from '@studyhub/contracts';

import { callApi } from './client-api';

export type UploadPhase = 'uploading' | 'checking' | 'ready' | 'rejected' | 'failed';

/**
 * Uploads a file the way F11 describes: ask the API for a slot, PUT the file straight to storage (or to
 * the video provider), confirm, then wait while the worker verifies and scans it. The API never sees
 * the file's bytes.
 */
export async function uploadFile(
  file: File,
  purpose: 'COURSE_COVER' | 'AVATAR' | 'LESSON_FILE' | 'LESSON_IMAGE' | 'LESSON_VIDEO',
  onPhase: (phase: UploadPhase, detail?: string) => void,
): Promise<AssetStatus | null> {
  onPhase('uploading');
  const isVideo = purpose === 'LESSON_VIDEO';
  const body = { fileName: file.name, mime: file.type || 'application/octet-stream', sizeBytes: file.size };
  const slot = await callApi<UploadSlot>(
    'POST',
    isVideo ? '/api/v1/videos' : '/api/v1/uploads',
    isVideo ? body : { ...body, purpose },
  );
  if (!slot.ok) {
    onPhase('failed', slot.problem.detail ?? slot.problem.title);
    return null;
  }
  try {
    const put = await fetch(slot.data.uploadUrl, { method: 'PUT', body: file, headers: slot.data.headers });
    if (!put.ok) throw new Error(String(put.status));
  } catch {
    onPhase('failed');
    return null;
  }
  if (!isVideo) {
    const done = await callApi<AssetStatus>('POST', `/api/v1/uploads/${slot.data.assetId}/complete`);
    if (!done.ok) {
      onPhase('failed', done.problem.title);
      return null;
    }
  }
  onPhase('checking');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await callApi<AssetStatus>('GET', `/api/v1/assets/${slot.data.assetId}`);
    if (status.ok && status.data.status === 'READY') {
      onPhase('ready');
      return status.data;
    }
    if (status.ok && status.data.status === 'REJECTED') {
      onPhase('rejected', status.data.rejectReason ?? undefined);
      return status.data;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt < 10 ? 500 : 2000));
  }
  onPhase('failed');
  return null;
}
