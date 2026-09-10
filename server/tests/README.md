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
| `src/lib/atomicWrite.ts` | `runAtomicIntent(executor, cte)` applied/not-applied + rollback proof |
| `src/utils/jobSweeper.ts` | stale processing/uploading sweeps with fake clock/db/dispatch |
| job dispatcher | direct-HTTP adapter retry/backoff; typed throw on final failure |
| webhook handler | late-callback/state guards |
| tenant webhook dispatcher | retry policy + signature headers |

## Real-database tests

Postgres-backed suites use `tests/helpers/db.ts`:

```ts
import { createTestDb, hasTestDatabase } from '../helpers/db'

describe.skipIf(!hasTestDatabase)('...', () => {
  let handle: TestDbHandle
  beforeAll(async () => { handle = createTestDb(); await handle.exec(DDL) })
  afterAll(async () => { await handle.close() })
})
```

- Gate every DB suite with `describe.skipIf(!hasTestDatabase)` so
  `pnpm test` still runs on a machine without Postgres.
- **Atomicity, locking and lease guarantees must be proven on a real database.**
  A fake executor can prove which function was called; it cannot prove Postgres
  rolled back. Keep fakes for pure planners only.
- Give each suite its own probe tables and state its own preconditions rather
  than depending on the production schema.
- The test driver is `postgres-js`. `neon-http` is a Workers-only HTTP
  transport and cannot be pointed at a local container, so its *result shape*
  is covered by `normalizeRows` unit tests instead.

## Rules

- Red → green, one vertical slice per cycle.
- Expected values come from worked examples/literals, never re-derived from the
  code under test.
- Integration tests needing Postgres read `TEST_DATABASE_URL` and skip when
  unset. CI runs a Postgres service (`.github/workflows/ci.yml`).

## Commands

```bash
pnpm test          # vitest run
pnpm test:watch    # vitest (watch)
```
