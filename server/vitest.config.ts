import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    // Integration suites share one Postgres database, and the deliverables/drain
    // workers are global by design — they claim whichever row is due, not just
    // the rows the current file created. Running files in parallel therefore
    // lets one suite send or clean up another suite's rows. Serialising files
    // costs a second or two and removes the whole class of flakiness.
    fileParallelism: false,
    // Integration tests that need a real database read TEST_DATABASE_URL
    // and skip when it is not set (CI provides a Postgres service).
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    },
  },
})
