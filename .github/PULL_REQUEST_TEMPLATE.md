## What does this PR do?

<!-- Concise description of the change and the problem it solves. -->

## Related issues

<!-- Fixes #123 -->

## Testing (TDD)

<!-- Every behavior change needs tests, written red → green at the agreed seams. -->

- [ ] Added/updated unit tests (package + what they cover)
- [ ] Integration tests updated (if applicable)
- [ ] Ran: `pnpm lint && pnpm typecheck && pnpm test`
- [ ] Python changes: `cd transcoding && python -m pytest tests`
- [ ] CI is green (lint, typecheck, tests, builds, Docker smoke, branding gate)

## Checklist

- [ ] No secrets or `.env`/`.dev.vars` files added
- [ ] No regenerable artifacts (`dist/`, `__pycache__/`) committed
- [ ] Docs updated where behavior changed
- [ ] CHANGELOG/roadmap note added if user-facing

## Screenshots / logs

<!-- Optional; redact any secrets. -->
