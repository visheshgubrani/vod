/**
 * Single local-config loader for every Node-side entrypoint.
 *
 * Precedence, highest first:
 *   1. real environment variables (Docker/compose, CI, shell exports)
 *   2. server/.dev.vars   — canonical local config
 *   3. server/.env        — optional fallback for anyone who prefers it
 *
 * Missing files are not an error: in the container both are absent and the
 * runtime is configured entirely through the environment.
 */
import { config } from 'dotenv'

config({ path: ['.dev.vars', '.env'], quiet: true })
