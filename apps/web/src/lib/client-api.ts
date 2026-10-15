'use client';

/**
 * Browser-side calls to the API through the same origin (/api/v1 and /api/console are proxied by the
 * web server). Same-origin requests carry the Origin header the API's CSRF check expects.
 */
export interface Problem {
  code: string;
  title: string;
  detail?: string;
  status: number;
  errors?: { field: string; message: string }[];
  retryAfter?: number;
}

export type ApiResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; problem: Problem };

export async function callApi<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  /** Extra request headers, e.g. Idempotency-Key for orders, payments and refunds (04 §7.2). */
  extraHeaders?: Record<string, string>,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, status: 0, problem: { code: 'NETWORK', title: '', status: 0 } };
  }
  const text = await response.text();
  const json: unknown = text === '' ? null : JSON.parse(text);
  if (response.ok) return { ok: true, status: response.status, data: json as T };
  return {
    ok: false,
    status: response.status,
    problem: (json ?? { code: 'UNKNOWN', title: '', status: response.status }) as Problem,
  };
}

/** A one-time token passed in the URL fragment (#token=…), which never reaches servers or logs. */
export function fragmentToken(): string | null {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  return match?.[1] ?? null;
}

/** Field errors keyed by field name, and the message for anything that isn't a field. */
export function splitProblem(
  problem: Problem,
  networkMessage: string,
): { fields: Record<string, string>; summary: string | null } {
  if (problem.code === 'NETWORK') return { fields: {}, summary: networkMessage };
  const fields: Record<string, string> = {};
  for (const error of problem.errors ?? []) fields[error.field] ??= error.message;
  const summary = Object.keys(fields).length > 0 ? null : (problem.detail ?? problem.title);
  return { fields, summary };
}

/**
 * Full page load to a same-site path (not client-side routing), so every server component re-reads the
 * new session after sign-in, sign-out or switching. Built as an absolute URL on this origin.
 */
export function reloadTo(path: string): void {
  window.location.assign(new URL(path, window.location.origin).href);
}

/** A fresh Idempotency-Key for one user action (a retry of the same action reuses it). */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}
