/**
 * Shared query predicates.
 *
 * `notDeleted` exists because soft deletion is only correct if *every* library
 * read excludes deleted rows. That is easy to forget at one of ~30 call sites,
 * and a forgotten filter is not a visible bug — it silently resurrects a video
 * the tenant believes they deleted. Compose it into every read of `video`:

 * ```ts
 * db.select().from(video).where(and(notDeleted, eq(video.id, id)))
 * ```
 *
 * `src/db/predicates.test.ts` and the CI guard in `.github/workflows/ci.yml`
 * exist to catch a call site that forgets it.
 */
import { isNull } from 'drizzle-orm'
import { video } from './schema'

/** True only for rows that have not been soft-deleted. */
export const notDeleted = isNull(video.deletedAt)
