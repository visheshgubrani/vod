import { describe, expect, it } from 'vitest'
import { runCapture } from '../src/runners'

describe('runCapture timeout contract', () => {
  it('does not kill a child when timeoutMs is zero', async () => {
    const result = await runCapture(
      [process.execPath, '-e', 'process.stdout.write("finished")'],
      { timeoutMs: 0 },
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('finished')
    expect(result.timedOut).toBe(false)
  })

  it('kills a child and reports a timeout when the limit is reached', async () => {
    const result = await runCapture(
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 200)'],
      { timeoutMs: 20 },
    )

    expect(result.code).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGTERM')
  })
})
