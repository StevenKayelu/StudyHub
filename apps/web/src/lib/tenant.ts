import 'server-only';

import { localizedText, type TenantBootstrap } from '@studyhub/contracts';
import { compileAccent, type CompiledAccent, themeCss } from '@studyhub/ui/theme';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { classifyHost, hostnameOf } from './hosts';
import { getTenantBootstrap } from './server-api';

/** The school for a host, fetched once per request (React cache) and shared by layouts, pages and i18n. */
export const loadTenant = cache((host: string): Promise<TenantBootstrap | null> => getTenantBootstrap(host));

/**
 * The school for an internal /_tenant/[host] route, or null. The [host] segment (set by the rewrite)
 * must equal the request's own host: src/proxy.ts already refuses direct /_tenant requests, and this
 * keeps every school route safe even if a rewrite rule were ever wrong.
 */
export async function tenantForRoute(routeHost: string): Promise<TenantBootstrap | null> {
  const host = decodeURIComponent(routeHost);
  if (hostnameOf((await headers()).get('host')) !== host) return null;
  return loadTenant(host);
}

/** The school of the current request, from the Host header (null on platform and console hosts). */
export async function currentTenant(): Promise<TenantBootstrap | null> {
  const host = (await headers()).get('host');
  if (classifyHost(host) !== 'school') return null;
  return loadTenant(hostnameOf(host));
}

/**
 * The compiled accent of a school, or null for the Copperline default. A stored accent that the
 * compiler now rejects (rules tightened since it was saved) also falls back to the default, so a page
 * never renders with non-compliant contrast.
 */
export const compiledAccent = cache((accentHex: string | null): CompiledAccent | null => {
  if (accentHex === null) return null;
  const result = compileAccent(accentHex);
  return result.ok ? result.accent : null;
});

export function tenantThemeCss(tenant: TenantBootstrap): string {
  return themeCss({
    accent: compiledAccent(tenant.branding.accentHex),
    fontPreset: tenant.branding.fontPreset,
  });
}

export type Terms = {
  instructor: string;
  instructors: string;
  course: string;
  courses: string;
  instructorLower: string;
  instructorsLower: string;
  courseLower: string;
  coursesLower: string;
};

/**
 * The school's terminology in the request locale (06 §10.1): its own word when set (falling back to
 * its default locale, BR-61), otherwise the platform's word from the message catalog. Pass the result
 * as values to any message that mentions instructors or courses.
 */
export async function getTerms(tenant: TenantBootstrap | null, locale: string): Promise<Terms> {
  const t = await getTranslations({ locale, namespace: 'terms' });
  const pick = (key: 'instructor' | 'instructors' | 'course' | 'courses') =>
    (tenant === null
      ? null
      : localizedText(tenant.branding.terminology[key], locale, tenant.locales.defaultLocale)) ?? t(key);
  const terms = {
    instructor: pick('instructor'),
    instructors: pick('instructors'),
    course: pick('course'),
    courses: pick('courses'),
  };
  return {
    ...terms,
    instructorLower: terms.instructor.toLocaleLowerCase(locale),
    instructorsLower: terms.instructors.toLocaleLowerCase(locale),
    courseLower: terms.course.toLocaleLowerCase(locale),
    coursesLower: terms.courses.toLocaleLowerCase(locale),
  };
}
