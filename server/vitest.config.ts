import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    // Integration tests that need a real database read TEST_DATABASE_URL
    // and skip when it is not set (CI provides a Postgres service).
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    },
  },
})
