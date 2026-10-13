# M3 design note: Copperline design system, theming runtime and shells

- **Status:** IMPLEMENTED (2026-10-13). Decisions marked **PROPOSED** below were made during implementation and need client confirmation; none blocks M4.
- **Baseline:** M2 commit `550390d`; blueprint `docs/blueprint/` (revision 4)
- **Scope (07 §M3):** Copperline tokens and components with Storybook; theme compiler and per-school theme CSS, manifest, icons and OG routes; 3 font presets; i18n with per-school enabled locales and terminology substitution; shells (Public, Learn, Studio, Tenant admin, Console); system screens S-X01–S-X08.
- **Q-PRD-5 (Next.js vs SPA):** no firm "no" was received, so the default stands (Next.js, ADR-004).

## 1. What was built

| Area               | Where                                                                  | Notes                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens             | `packages/ui/src/tokens/tokens.ts` → generated `src/styles/tokens.css` | 06 §2.1–2.4; light and dark themes (system preference, overridable with `data-theme`)                                                                                                                                                           |
| Tailwind 4 mapping | `packages/ui/src/styles/index.css`                                     | Default palette, type scale and breakpoints removed: only semantic tokens exist                                                                                                                                                                 |
| Theme compiler     | `packages/ui/src/theme/` (`@studyhub/ui/theme`)                        | OKLCH; BR-51; suggestions; framework-free (API can validate on save)                                                                                                                                                                            |
| Components         | `packages/ui/src/components/`                                          | Button, TextField/TextArea, ErrorSummary, Checkbox, RadioGroup, Switch, Select, Dialog, Sheet, Tabs, SecondaryNav, Alert, Banner, StatusBadge, SaveIndicator, Skeleton, Toast, Card, StatCard, Money, ProgressLine, Stepper, StatePanel, shells |
| Storybook          | `packages/ui/.storybook`, `*.stories.tsx` (22 stories)                 | Toolbar: theme (default + 2 school themes) and scheme                                                                                                                                                                                           |
| Data               | migration `0003_tenant_branding_settings`                              | `tenant_branding`, `tenant_branding_version`, `tenant_setting`; forced RLS; runtime role read-only                                                                                                                                              |
| API                | `GET /api/v1/tenant`                                                   | Now includes published `branding` and `locales` (defaults when no row)                                                                                                                                                                          |
| Web                | `apps/web/src/app/%5Ftenant/[host]/…`, `%5Fconsole`, `%5Fsystem`       | Shells, system screens, theme/manifest/icon/OG routes, console host                                                                                                                                                                             |

### Routes per school host

| Path                                                                      | Purpose                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/`, `/learn`, `/studio`, `/admin`                                        | Public, Learn, Studio and Admin shells (placeholders; access control is M4)                           |
| `/theme/{tenantId}/{version}.css`                                         | Theme CSS, `immutable`; 404 for another school's id or a stale version                                |
| `/manifest.webmanifest`, `/mark.svg`, `/icon/192`, `/icon/512`, `/og.png` | PWA manifest, favicon, app icons and OG image in the school's brand (monogram until logo upload, F39) |
| `/offline`                                                                | S-X03                                                                                                 |
| anything else                                                             | S-X01 (404, in the school's theme)                                                                    |

The theme CSS (< 1 KB) is also inlined in `<head>` (a hoisted React `<style>`), so the first paint is branded.

### System screens

| Screen                  | How it appears                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S-X01 Not found         | Unknown path on a school host → 404 in the school shell                                                                                      |
| S-X02 Error             | `error.tsx` in the school segment (strings passed from the server layout)                                                                    |
| S-X03 Offline           | `/offline` (the service worker that serves it is PWA work, later)                                                                            |
| S-X04 Maintenance       | `MAINTENANCE_MODE=on` → every page request served `/_system/maintenance` with 503 and `Retry-After` (API unaffected)                         |
| S-X05 Permission denied | `StatePanel kind="permission"` (Storybook). Next's `forbidden()` is still experimental in Next 16, so M4's guards will render the component  |
| S-X06 Site not found    | Unknown host → neutral 404, platform default theme, no school hints (BR-60)                                                                  |
| S-X07 Unavailable       | School status SUSPENDED or OFFBOARDING → neutral page with the school's name (BR-52's read-only access for learners arrives with enrolments) |
| S-X08 Coming soon       | School status PROVISIONING → name and owner sign-in link                                                                                     |

### Console host

`CONSOLE_HOSTS` (default `console.localhost`) is rewritten to the internal `/_console` route, with the fixed info-blue console theme and the "Platform console" strip (06 §10.3). `console` is a reserved school slug (BR-50), so it can never be a school. The proxy refuses direct requests to `/_tenant`, `/_console` and `/_system` from any host.

## 2. Theme compiler

1. Parse `#rrggbb` → OKLCH.
2. **Light theme:** keep the colour if every pair passes; otherwise lower lightness in 0.005 steps. If the colour must change by more than **0.15 lightness** (PROPOSED threshold) it is rejected as `TOO_LIGHT`.
3. **Dark theme:** start at the light lightness + 0.2187 and raise until every pair passes (`NO_DARK_VARIANT` if impossible).
4. Derived tokens (`accent-hover`, `accent-soft`, `on-accent`) use offsets fitted to the copper reference.
5. Every pair is measured on the final hex values: accent on canvas, surface and accent-soft; on-accent on accent and accent-hover; all **≥ 4.5:1** (stricter than BR-51's 3:1 against backgrounds, because the accent is also used for link text).
6. Rejected colours get up to 3 suggestions: the lightest compliant version for nearby hues (±12°, ±24°, ±40°), ordered by ΔE_OK; darker steps fill in for greys.

**Copper reference (deviation from 06 §10.1, PROPOSED):** the 06 §2.2 copper values are hand-tuned (their hue drifts from 42.8° to 56° across tokens), so no single formula reproduces them exactly. The compiler keeps `#A3471C` and `#FFFFFF` exactly and reproduces every other copper token within **ΔE_OK < 0.02** (below a just-noticeable difference). The shipped default theme keeps the exact 06 §2.2 values. A school that has no accent set uses the defaults; the test asserts the tolerance.

**Demo schools (seed):** Acme = Copperline default; Beta = `#0b7285` + Humanist + "Lecturer"/"Module"; Gamma = provisioning (`#6d28d9` + Geometric).

## 3. Font presets (PROPOSED families)

| Preset               | UI                         | Reading        | Files per page (Latin, variable WOFF2) |
| -------------------- | -------------------------- | -------------- | -------------------------------------- |
| Copperline (default) | Atkinson Hyperlegible Next | Literata       | 34 KB + 52 KB                          |
| Humanist             | Source Sans 3              | Source Serif 4 | 29 KB + 51 KB                          |
| Geometric            | Plus Jakarta Sans          | Literata       | 27 KB + 52 KB                          |

All SIL OFL 1.1 (licences next to the files in `apps/web/src/fonts/`). One variable file covers all weights, so each preset is 2 files and ≤ 86 KB (06 §9: ≤ 4 files, ≤ 120 KB). Only the default UI font is preloaded; reading fonts load only on pages that use them.

## 4. i18n

- `next-intl`, server only; no locale prefix in URLs.
- Locale per request: user preference (from M4, if the school enables it) → Accept-Language for anonymous visitors, within enabled locales → school default (`resolveRequestLocale` in `@studyhub/contracts`).
- Message catalogs: only `en`. Missing keys fall back to the school default locale and then English (`loadMessages`).
- Tenant texts are stored per locale and fall back to the default locale (`localizedText`, BR-61; unit-tested, M3 AC 4).
- Terminology: messages take `{instructor}`, `{instructors}`, `{course}`, `{courses}` and lower-case variants; the school's own word wins, the catalog's otherwise.

## 5. Tests and results (M3 acceptance criteria)

| AC                                                         | Test                                                                                                                                                                         | Result                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1 Axe: 0 serious on all stories, default + 2 school themes | `packages/ui/tests/stories.spec.ts`: 22 stories × (3 themes light + default dark) = 88 runs; plus axe on every shell and system page in `apps/web/tests/e2e/theming.spec.ts` | Pass                                                                                     |
| 2 Visual regression at 5 widths                            | Same file: 22 stories × 320/375/768/1024/1440 = 110 baselines, plus a no-horizontal-scroll check                                                                             | Pass (baselines are platform-specific: `*-win32.png`; CI on Linux needs its own, see §6) |
| 3 Theme property test; copper reference                    | `packages/ui/src/theme/compiler.test.ts`: 10,000 random colours; copper within ΔE_OK < 0.02                                                                                  | Pass                                                                                     |
| 4 Locale fallback                                          | `packages/contracts/src/i18n.test.ts`                                                                                                                                        | Pass                                                                                     |
| 5 Lighthouse budget, public shell                          | `apps/web/tests/e2e/lighthouse.spec.ts`                                                                                                                                      | Pass with the interpretation below                                                       |
| UX-09 token contrast                                       | `packages/ui/src/tokens/tokens.test.ts` (light, dark, console light, console dark)                                                                                           | Pass                                                                                     |

**Lighthouse (mobile, simulated Slow 4G, acme home):** performance 0.96–0.98, accessibility 1.0, LCP 1.4–2.4 s, fonts 33 KB in 1 file, JavaScript 143 KB compressed in total = **132 KB shared framework** (Next.js 16 + React 19 `rootMainFiles`) + **11 KB route**.

**JavaScript budget interpretation (needs a decision):** 06 §9 says "JS (compressed, route) ≤ 120 KB". The framework runtime alone is ~132 KB compressed, so a total-page reading can't be met by any Next.js 16 page. The test therefore budgets **route JS ≤ 120 KB** (the page's own chunks) and adds a **total ≤ 150 KB** regression ceiling. To get there, M3 kept the next-intl client runtime and Radix out of public pages.

## 6. Open items and follow-ups

1. Confirm the PROPOSED choices: 0.15 lightness threshold, ≥ 4.5:1 for all accent pairs, the Humanist and Geometric font families, the copper ΔE tolerance, and the JS budget interpretation.
2. Visual-regression baselines exist for Windows only. Generating Linux baselines in CI (or a pinned Playwright Docker image) is needed before the story tests can gate CI on Linux; until then CI runs them in `--grep axe` mode only.
3. Not built in M3 (belong to the milestones that use them): Timer line, Navigator grid, Choice cards, Phone input, Combobox, Table, Course card, Rich text, Media players.
4. The branding editor (F39) will write `tenant_branding` through the API and validate with `@studyhub/ui/theme`; the runtime role then needs INSERT/UPDATE on it.
5. Per-host ISR caching of public pages arrives with the catalogue (M5); school pages are dynamic now.
