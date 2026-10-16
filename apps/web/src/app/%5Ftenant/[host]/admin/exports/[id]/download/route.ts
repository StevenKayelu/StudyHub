import { exportSchema } from '@studyhub/contracts';
import { NextResponse } from 'next/server';

import { apiGet } from '../../../../../../../lib/session';

/** Download of a READY export: a fresh short-lived link from the API, then a redirect to it (F32, F46). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  const response = await apiGet(`/api/v1/admin/exports/${id}`);
  if (!response.ok) return new NextResponse('Not available', { status: response.status === 403 ? 403 : 404 });
  const view = exportSchema.parse(await response.json());
  if (view.downloadUrl === null) return new NextResponse('Not ready', { status: 409 });
  return NextResponse.redirect(view.downloadUrl, 303);
}
