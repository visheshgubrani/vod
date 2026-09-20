import { describe, expect, it } from 'vitest'
import {
  AnalyticsEngineQueryError,
  analyticsQueryFailureStatus,
} from '../../src/lib/analytics-engine'

const AUTH_9106 =
  '{"success":false,"errors":[{"code":9106,"message":"Authentication failed (status: 400)"}],"messages":[],"result":null}\n'

describe('analyticsQueryFailureStatus', () => {
  it('treats a 400 authentication rejection as unconfigured, not a server error', () => {
    expect(
      analyticsQueryFailureStatus(new AnalyticsEngineQueryError(400, AUTH_9106)),
    ).toBe(501)
  })

  it('treats 401 and 403 the same way', () => {
    expect(analyticsQueryFailureStatus(new AnalyticsEngineQueryError(401, 'unauthorized'))).toBe(
      501,
    )
    expect(analyticsQueryFailureStatus(new AnalyticsEngineQueryError(403, 'forbidden'))).toBe(501)
  })

  it('keeps a SQL dialect refusal as a 500', () => {
    expect(
      analyticsQueryFailureStatus(
        new AnalyticsEngineQueryError(
          422,
          'Input was invalid: the 2nd and 3rd arguments to IF() must have the same type',
        ),
      ),
    ).toBe(500)
  })

  it('keeps an unknown throw as a 500', () => {
    expect(analyticsQueryFailureStatus(new Error('socket hang up'))).toBe(500)
  })
})
