# Server tests (vitest)

Test suites live next to a `tests/` directory at the package root (or co-located
`*.test.ts` next to the module under test — both are picked up).

## Seams (pre-agreed — test behavior at public interfaces, never internals)

See the plan / docs for the full table. The critical-path seams:

| Module | Interface under test |
| --- | --- |
| `src/lib/config.ts` | `loadConfig(env) -> Config` (validated or typed error) |
| origin matcher | `matchOrigin(origin, patterns)` incl. `*.` wildcards |
| video state machine | `transitionVideo(db, id, from[], to)` allowed/denied transitions |
| `src/utils/jobSweeper.ts` | stale processing/uploading sweeps with fake clock/db/dispatch |
| job dispatcher | direct-HTTP adapter retry/backoff; typed throw on final failure |
| webhook handler | late-callback/state guards |
| tenant webhook dispatcher | retry policy + signature headers |

## Rules

- Red → green, one vertical slice per cycle.
- Expected values come from worked examples/literals, never re-derived from the
  code under test.
- Integration tests needing Postgres read `TEST_DATABASE_URL` and skip when
  unset. CI runs a Postgres service.

## Commands

```bash
pnpm test          # vitest run
pnpm test:watch    # vitest (watch)
```
