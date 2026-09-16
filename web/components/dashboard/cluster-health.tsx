"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { API_BASE_URL, apiOrigin } from "@/lib/api-base";
import { cn } from "@/lib/utils";

const ORIGIN = apiOrigin(API_BASE_URL);
const CONFIG_URL = `${ORIGIN}/health/config`;
const HEALTH_URL = `${ORIGIN}/health`;
const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 6_000;

interface CheckDefinition {
  key: string;
  label: string;
  hint: string;
}

const CHECK_DEFINITIONS: CheckDefinition[] = [
  { key: "database", label: "Database", hint: "Postgres" },
  { key: "storage", label: "Storage", hint: "Cloudflare R2" },
  { key: "transcoder", label: "Transcoder", hint: "Configured provider" },
  // The raw bucket is required by *uploading*, not by transcoding. A local-only
  // installation has none and is healthy, so this is reported as a capability
  // rather than as a missing requirement.
  { key: "rawUploads", label: "Raw uploads", hint: "Browser / SDK files" },
  { key: "auth", label: "Auth / JWT", hint: "Sessions and keys" },
  { key: "analytics", label: "Analytics", hint: "Playback + bandwidth" },
  { key: "ai", label: "AI", hint: "Subtitles" },
  { key: "delivery", label: "Delivery", hint: "Media worker URL" },
];

type CheckStatus = "ok" | "down" | "unknown";

interface CheckState {
  key: string;
  label: string;
  hint: string;
  status: CheckStatus;
}

interface HealthConfig {
  ready: boolean;
  checks: Record<string, unknown>;
  problems: string[];
}

type PollResult =
  | { kind: "live"; config: HealthConfig; at: Date }
  | { kind: "config-missing"; detail: string; at: Date }
  | { kind: "unreachable"; detail: string; at: Date };

interface ClusterHealthState {
  poll: PollResult | null;
  loading: boolean;
}

/** Status → the words and the token that carry it, in one place. */
const CHECK_STATUS_STYLES: Record<
  CheckStatus,
  { label: string; dot: string; text: string; icon: ReactNode }
> = {
  ok: {
    label: "Healthy",
    dot: "bg-ready",
    text: "text-ready",
    icon: <CheckCircle2 className="size-4" aria-hidden="true" />,
  },
  down: {
    label: "Unavailable",
    dot: "bg-failed",
    text: "text-failed",
    icon: <XCircle className="size-4" aria-hidden="true" />,
  },
  unknown: {
    label: "No report",
    dot: "bg-processing",
    text: "text-processing",
    icon: <HelpCircle className="size-4" aria-hidden="true" />,
  },
};

function isHealthConfig(value: unknown): value is HealthConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ready !== "boolean") {
    return false;
  }
  if (typeof candidate.checks !== "object" || candidate.checks === null) {
    return false;
  }
  if (
    candidate.problems !== undefined &&
    !(
      Array.isArray(candidate.problems) &&
      candidate.problems.every((problem) => typeof problem === "string")
    )
  ) {
    return false;
  }
  return true;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "request timed out";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown error";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

function toCheckStates(config: HealthConfig): CheckState[] {
  return CHECK_DEFINITIONS.map((definition) => {
    const reported = config.checks[definition.key];
    const status: CheckStatus =
      reported === true ? "ok" : reported === false ? "down" : "unknown";
    return {
      key: definition.key,
      label: definition.label,
      hint: definition.hint,
      status,
    };
  });
}

async function pollHealth(): Promise<PollResult> {
  const at = new Date();
  const [configResult, healthResult] = await Promise.allSettled([
    fetchWithTimeout(CONFIG_URL, FETCH_TIMEOUT_MS),
    fetchWithTimeout(HEALTH_URL, FETCH_TIMEOUT_MS),
  ]);

  if (configResult.status === "fulfilled") {
    const response = configResult.value;
    if (response.ok) {
      try {
        const body: unknown = await response.json();
        if (isHealthConfig(body)) {
          return { kind: "live", config: body, at };
        }
        return {
          kind: "config-missing",
          detail: `${CONFIG_URL} answered with an unexpected payload`,
          at,
        };
      } catch (error) {
        return {
          kind: "config-missing",
          detail: `${CONFIG_URL} did not return valid JSON (${errorMessage(error)})`,
          at,
        };
      }
    }
    if (healthResult.status === "fulfilled" && healthResult.value.ok) {
      return {
        kind: "config-missing",
        detail: `${CONFIG_URL} answered HTTP ${response.status} — the health/config contract is not deployed yet`,
        at,
      };
    }
  }

  const apiAlive =
    healthResult.status === "fulfilled" && healthResult.value.ok;
  if (apiAlive) {
    return {
      kind: "config-missing",
      detail: `${CONFIG_URL} is not reachable`,
      at,
    };
  }

  const healthFailure =
    healthResult.status === "fulfilled" && !healthResult.value.ok
      ? `HTTP ${healthResult.value.status}`
      : healthResult.status === "rejected"
        ? errorMessage(healthResult.reason)
        : "";
  const configFailure =
    configResult.status === "rejected" ? errorMessage(configResult.reason) : "";
  return {
    kind: "unreachable",
    detail: `GET ${CONFIG_URL} → ${configFailure || "failed"}${
      healthFailure ? ` · GET ${HEALTH_URL} → ${healthFailure}` : ""
    }`,
    at,
  };
}

export function ClusterHealth() {
  const [state, setState] = useState<ClusterHealthState>({
    poll: null,
    loading: true,
  });
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const runPoll = async () => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      let poll: PollResult;
      try {
        poll = await pollHealth();
      } catch {
        poll = { kind: "unreachable", detail: "health check failed", at: new Date() };
      } finally {
        inFlight.current = false;
      }
      if (!cancelled) {
        setState({ poll, loading: false });
      }
    };

    void runPoll();
    const interval = setInterval(() => {
      void runPoll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const renderStatusBanner = () => {
    const { poll } = state;
    if (!poll || poll.kind !== "live") {
      return null;
    }
    const checks = toCheckStates(poll.config);
    const downChecks = checks.filter((check) => check.status === "down");
    const unknownChecks = checks.filter((check) => check.status === "unknown");
    const degraded = !poll.config.ready || downChecks.length > 0;
    const isOperational = !degraded && unknownChecks.length === 0;
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-3 rounded-[14px] border px-5 py-4 text-[15px] font-semibold",
          degraded
            ? "border-processing/35 bg-processing/10 text-processing"
            : isOperational
              ? "border-ready/35 bg-ready/10 text-ready"
              : "border-info/35 bg-info/10 text-info",
        )}
      >
        <span
          className={cn(
            "dash-dot size-2.5",
            degraded ? "bg-processing" : isOperational ? "bg-ready" : "bg-info",
          )}
          aria-hidden="true"
        />
        {degraded
          ? "Degraded — some checks are failing"
          : isOperational
            ? "All systems operational"
            : "Operational, with unreported checks"}
      </div>
    );
  };

  const renderCheckCards = () => {
    const { poll, loading } = state;
    if (loading || !poll) {
      return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="dash-skeleton h-[5.5rem] rounded-[14px]"
            />
          ))}
        </div>
      );
    }

    if (poll.kind !== "live") {
      const isUnreachable = poll.kind === "unreachable";
      return (
        <div className="dash-panel flex flex-col items-center gap-3 border-processing/35 px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full border border-processing/35 bg-processing/10">
            <AlertCircle
              className="size-6 animate-pulse text-processing"
              aria-hidden="true"
            />
          </span>
          <p className="text-[15px] font-semibold text-foreground">
            {isUnreachable
              ? "API unreachable — is the server running?"
              : "Health/config endpoint is not reporting"}
          </p>
          <code className="dash-code max-w-full break-all rounded-lg border border-border-soft bg-panel-quiet px-3 py-1.5 text-[13px] text-muted-foreground">
            {CONFIG_URL}
          </code>
          <p className="dash-body max-w-[62ch] text-muted-foreground">
            {poll.detail}
          </p>
        </div>
      );
    }

    const checks = toCheckStates(poll.config);
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-4">
        {checks.map((check) => {
          const style = CHECK_STATUS_STYLES[check.status];
          return (
            <div
              key={check.key}
              className="dash-panel p-4 transition-colors hover:border-muted-foreground/40 md:p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-[15px] font-semibold text-foreground">
                  {check.label}
                </p>
                <span
                  className={cn("mt-1.5 dash-dot size-2.5", style.dot)}
                  aria-hidden="true"
                />
              </div>
              <p className="dash-meta mt-1">{check.hint}</p>
              <p
                className={cn(
                  "mt-3 flex items-center gap-2 text-[13px] font-medium",
                  style.text,
                )}
              >
                {style.icon}
                {style.label}
              </p>
            </div>
          );
        })}
      </div>
    );
  };

  const { poll } = state;
  const problems = poll?.kind === "live" ? poll.config.problems : [];

  return (
    <div className="space-y-3">
      {renderStatusBanner()}
      {renderCheckCards()}
      {problems.length > 0 && (
        <ul className="dash-panel-quiet space-y-1.5 border-processing/30 px-4 py-4">
          {problems.map((problem, index) => (
            <li
              key={index}
              className="dash-body list-inside list-disc text-processing"
            >
              {problem}
            </li>
          ))}
        </ul>
      )}
      <p className="dash-meta flex flex-wrap items-center justify-between gap-2 px-1">
        <span>
          {poll
            ? `Last checked ${poll.at.toLocaleTimeString()}`
            : "Checking endpoints…"}
        </span>
        <span>Runs in your browser · refreshes every 30s</span>
      </p>
    </div>
  );
}
