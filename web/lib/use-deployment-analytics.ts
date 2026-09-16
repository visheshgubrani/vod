"use client";

/**
 * What this deployment can actually do, from `GET /health/config`.
 *
 * Only the analytics axes are modelled. The dashboard needs them because
 * "playback views are zero because nobody watched" and "playback views are zero
 * because nothing is recording them" look identical in a chart, and only the
 * deployment shape tells them apart: writing playback telemetry needs a
 * Cloudflare Worker with the `PLAYBACK_ANALYTICS` binding, so a Node or
 * container API reads fine and records nothing.
 *
 * Three properties matter for how this is consumed:
 *
 * - **Unknown is distinct from "none".** A missing, older or unreachable
 *   `/health/config` yields `null`, and callers show nothing. Claiming "not
 *   recording" from a failed HTTP request would be a worse lie than the silence.
 * - **One request per page, not one per banner.** The in-flight promise is
 *   cached at module scope, so three mounted notices share a single probe.
 * - **The response is unvalidated by default.** `readHealthConfig` checks the
 *   fields this module reads before trusting them.
 */

import { useEffect, useState } from "react";
import { API_BASE_URL, apiOrigin } from "@/lib/api-base";

/** The subset of the `/health/config` payload this module reads. */
export interface DeploymentAnalyticsShape {
  runtime: string;
  /** `'workers-analytics-engine'` when the binding is present, else `'none'`. */
  analyticsWrite: string;
  /** `'cloudflare-sql'` when credentials are configured, else `'none'`. */
  analyticsRead: string;
}

const CONFIG_URL = `${apiOrigin(API_BASE_URL)}/health/config`;
const FETCH_TIMEOUT_MS = 6_000;

/**
 * The analytics axes of a shape, or null when they are absent.
 *
 * Exported and pure so the capability rule can be asserted without a browser —
 * this package has no test runner, and the server's `deployment.test.ts` covers
 * the other end of the same contract (which shape a runtime resolves to).
 */
export function readAnalyticsShape(
  payload: unknown,
): DeploymentAnalyticsShape | null {
  if (typeof payload !== "object" || payload === null) return null;

  const deployment = (payload as { deployment?: unknown }).deployment;
  if (typeof deployment !== "object" || deployment === null) return null;

  const { runtime, analyticsWrite, analyticsRead } = deployment as Record<
    string,
    unknown
  >;
  if (
    typeof runtime !== "string" ||
    typeof analyticsWrite !== "string" ||
    typeof analyticsRead !== "string"
  ) {
    return null;
  }

  return { runtime, analyticsWrite, analyticsRead };
}

/** The capability, shared by every caller instead of refetched per component. */
let cached: Promise<DeploymentAnalyticsShape | null> | null = null;

async function loadAnalyticsShape(): Promise<DeploymentAnalyticsShape | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CONFIG_URL, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return readAnalyticsShape(await response.json());
  } catch {
    // A probe that cannot answer is "unknown", never "disabled".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function useDeploymentAnalytics(): {
  shape: DeploymentAnalyticsShape | null;
  loading: boolean;
} {
  const [result, setResult] = useState<{
    shape: DeploymentAnalyticsShape | null;
    loading: boolean;
  }>({ shape: null, loading: true });

  useEffect(() => {
    let active = true;
    cached ??= loadAnalyticsShape();

    void cached.then((shape) => {
      if (active) setResult({ shape, loading: false });
    });

    return () => {
      active = false;
    };
  }, []);

  return result;
}
