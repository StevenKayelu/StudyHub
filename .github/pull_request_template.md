## What and why

<!-- What does this change do, and which blueprint milestone / feature / rule does it implement? -->

## Checklist

- [ ] Scope stays within the approved milestone; nothing from later milestones
- [ ] `pnpm verify` passes locally (or the failing gate is explained below)
- [ ] Tests added or updated for every behaviour change; none skipped without a written reason
- [ ] No business logic in controllers or React components
- [ ] Errors use problem+json with a stable code from `packages/contracts`
- [ ] No secrets, real credentials or personal data in code, tests, fixtures or logs
- [ ] Migrations are additive (expand/contract) and were applied to an empty database
- [ ] Module boundaries respected (`pnpm boundaries`)
- [ ] Docs/ADRs updated if a decision or convention changed

## Screenshots / notes

## Deviations from the blueprint

<!-- None, or list each deviation with the reason. -->
