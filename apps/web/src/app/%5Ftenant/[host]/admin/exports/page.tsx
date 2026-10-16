import { redirect } from 'next/navigation';

/** Exports live on the Reports page (S-AD07); the "export ready" email links here. */
export default function ExportsPage() {
  redirect('/admin/reports#exports');
}
