"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";
const CONFIG_URL = `${API_BASE}/health/config`;
const HEALTH_URL = `${API_BASE}/health`;
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
  { key: "transcoder", label: "Transcoder", hint: "Modal GPU" },
  { key: "auth", label: "Auth / JWT", hint: "Sessions and keys" },
  { key: "analytics", label: "Analytics", hint: "Playback + bandwidth" },
  { key: "ai", label: "AI", hint: "Subtitles" },
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
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-sm border px-4 py-3 text-sm font-medium",
          degraded
            ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full",
            degraded
              ? "bg-amber-500"
              : unknownChecks.length > 0
                ? "bg-amber-500"
                : "bg-emerald-500"
          )}
        />
        {degraded
          ? "Degraded — some checks are failing"
          : unknownChecks.length > 0
            ? "Operational, with unreported checks"
            : "All systems operational"}
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
              className="shimmer h-[5.5rem] rounded-sm border border-border bg-card/40"
            />
          ))}
        </div>
      );
    }

    if (poll.kind !== "live") {
      const isUnreachable = poll.kind === "unreachable";
      return (
        <div className="flex flex-col items-center gap-3 rounded-sm border border-amber-500/30 bg-card/50 px-6 py-8 text-center">
          <span className="size-3 animate-pulse rounded-full bg-amber-500" />
          <p className="font-semibold">
            {isUnreachable
              ? "API unreachable — is the server running?"
              : "Health/config endpoint is not reporting"}
          </p>
          <code className="max-w-full break-all rounded-sm bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
            {CONFIG_URL}
          </code>
          <p className="max-w-xl text-sm text-muted-foreground">{poll.detail}</p>
        </div>
      );
    }

    const checks = toCheckStates(poll.config);
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        {checks.map((check) => (
          <div
            key={check.key}
            className="rounded-sm border border-border bg-card/65 p-4 backdrop-blur-sm transition-colors hover:bg-card/70"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{check.label}</p>
              <span
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-full",
                  check.status === "ok" && "bg-emerald-500",
                  check.status === "down" && "bg-red-500",
                  check.status === "unknown" && "bg-amber-500"
                )}
              />
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{check.hint}</p>
            <p
              className={cn(
                "mt-2 text-xs font-medium",
                check.status === "ok" && "text-emerald-400",
                check.status === "down" && "text-red-400",
                check.status === "unknown" && "text-amber-400"
              )}
            >
              {check.status === "ok"
                ? "Healthy"
                : check.status === "down"
                  ? "Unavailable"
                  : "No report"}
            </p>
          </div>
        ))}
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
        <ul className="space-y-1.5 rounded-sm border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-300/90">
          {problems.map((problem, index) => (
            <li key={index} className="list-inside list-disc">
              {problem}
            </li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
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
