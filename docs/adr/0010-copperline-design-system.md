# ADR-0010: Copperline design system: Radix primitives, Tailwind 4 tokens, an OKLCH theme compiler

- **Status:** Accepted for implementation (blueprint ADR-010 recommendation; M3)
- **Date:** 2026-10-13
- **Blueprint reference:** `docs/blueprint/06-ui-ux-blueprint.md` §2, §9, §10; `04-target-architecture.md` §17.7–17.8; `docs/design/m3-design-system.md`

## Context

Every school brands its site, but quality (contrast, layout, accessibility, performance) must not depend on what a school picks. Components must be accessible by default and cheap to ship to mid-range Android phones.

## Decision

- **Package.** `packages/ui` (`@studyhub/ui`) holds the tokens, the theme compiler (`@studyhub/ui/theme`, framework-free, usable by the API) and the React components, with Storybook.
- **Tokens.** `src/tokens/tokens.ts` is the single source; `src/styles/tokens.css` is generated from it and a unit test fails on drift. Tailwind 4 `@theme` maps semantic tokens to utilities and **removes Tailwind's default palette, type scale and breakpoints**, so components can only use semantic tokens.
- **Primitives.** Radix (`radix-ui`) for dialog, sheet, select, tabs, checkbox, radio, switch and toast. Components that need no interactivity are server-safe; client islands are kept small (e.g. the workspace menu sheet).
- **Theme compiler.** A school sets one accent colour and a font preset. The compiler works in OKLCH, changes lightness only, checks every pair on the final 8-bit hex values, and rejects colours that would need more than 0.15 lightness change, offering 3 compliant suggestions (BR-51, UX-16). Output: accent tokens for light and dark themes, emitted as CSS variables.
- **Fonts.** Three curated presets, self-hosted as one Latin variable WOFF2 per family; a theme only switches CSS variables.
- **i18n.** `next-intl` on the server only; no locale in URLs; the school's enabled locales decide (04 §17.8). Client components receive translated strings as props.

## Consequences

- A school can't produce an inaccessible accent or load arbitrary fonts or CSS.
- The copper reference is reproduced by the compiler within ΔE_OK < 0.02 rather than exactly (see the design note); the shipped default keeps the hand-tuned 06 §2.2 values.
- Adding a component means adding stories; axe and visual regression run on every story.
