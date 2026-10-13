import { notFound } from 'next/navigation';

/** Any unknown path on a known school host renders that school's not-found page (S-X01). */
export default function UnknownSchoolPath(): never {
  notFound();
}
