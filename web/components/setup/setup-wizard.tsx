"use client";

import * as React from "react";
import { API_BASE_URL, apiOrigin } from "@/lib/api-base";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type HealthConfig = {
  ready: boolean;
  checks: {
    database: boolean;
    storage: boolean;
    transcoder: boolean;
    auth: boolean;
    analytics: boolean;
    ai: boolean;
    delivery: boolean;
  };
  problems: string[];
  advisories?: string[];
};

const CHECK_LABELS: Record<keyof HealthConfig["checks"], string> = {
  database: "Postgres database",
  storage: "Cloudflare R2 storage",
  transcoder: "Modal transcoder",
  auth: "Auth secrets (JWT / session)",
  analytics: "Analytics (optional)",
  ai: "AI subtitles (optional)",
  delivery: "Delivery worker URL (advisory)",
};

const HEALTH_CONFIG_URL = `${apiOrigin(API_BASE_URL)}/health/config`;

/** Inline command/env token inside body copy. */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border border-border-soft bg-panel-quiet px-1.5 py-0.5 font-mono text-[13px] text-foreground">
      {children}
    </code>
  );
}

export function SetupWizard() {
  const [config, setConfig] = React.useState<HealthConfig | null>(null);
  const [apiState, setApiState] = React.useState<"loading" | "ok" | "down">(
    "loading",
  );
  const [error, setError] = React.useState<string | null>(null);

  const check = React.useCallback(async () => {
    setApiState("loading");
    setError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(HEALTH_CONFIG_URL, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthConfig;
      setConfig(data);
      setApiState("ok");
    } catch (err) {
      setApiState("down");
      setError(
        err instanceof Error ? err.message : "API did not respond",
      );
    }
  }, []);

  React.useEffect(() => {
    void check();
  }, [check]);

  return (
    <div className="mt-10 space-y-5">
      {/* API reachability */}
      <section className="dash-panel p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="dash-section-title text-foreground">
            API reachability
          </h2>
          <span
            className={cn(
              "inline-flex items-center gap-2 text-[13px] font-medium",
              apiState === "ok"
                ? "text-ready"
                : apiState === "loading"
                  ? "text-processing"
                  : "text-failed",
            )}
          >
            <span className="dash-dot" aria-hidden="true" />
            {apiState === "ok"
              ? "reachable"
              : apiState === "loading"
                ? "probing…"
                : "unreachable"}
          </span>
        </div>
        <p className="dash-body mt-2 break-all text-muted-foreground">
          {HEALTH_CONFIG_URL} — is the API running?
        </p>
        {apiState === "down" && (
          <p className="dash-body mt-3 text-failed">
            Could not reach the API at {HEALTH_CONFIG_URL}. Start it with{" "}
            <Code>pnpm dev</Code> or <Code>docker compose up -d</Code>.
          </p>
        )}
        {error && apiState === "ok" && (
          <p className="dash-body mt-3 text-processing">
            Config parse: {error}
          </p>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void check()}
          className="mt-4"
        >
          Re-check
        </Button>
      </section>

      {/* Capability checks */}
      {config && (
        <section className="dash-panel p-5 md:p-6">
          <h2 className="dash-section-title text-foreground">
            Configured capabilities
          </h2>
          <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {(Object.keys(CHECK_LABELS) as Array<keyof HealthConfig["checks"]>).map(
              (key) => {
                const ok = config.checks[key];
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border-soft bg-panel-quiet px-3.5 py-2.5"
                  >
                    <span className="dash-body text-foreground">
                      {CHECK_LABELS[key]}
                    </span>
                    <span
                      className={cn(
                        "text-[13px] font-medium whitespace-nowrap",
                        ok ? "text-ready" : "text-failed",
                      )}
                    >
                      {ok ? "✓ configured" : "✗ missing"}
                    </span>
                  </li>
                );
              },
            )}
          </ul>
          {config.problems.length > 0 && (
            <ul className="dash-body mt-5 space-y-1.5 text-processing">
              {config.problems.map((problem) => (
                <li key={problem}>• {problem}</li>
              ))}
            </ul>
          )}
          {config.advisories?.map((advisory) => (
            <p key={advisory} className="dash-meta mt-2">
              {advisory}
            </p>
          ))}
        </section>
      )}

      {/* Next steps */}
      <section className="dash-panel p-5 md:p-6">
        <h2 className="dash-section-title text-foreground">Next steps</h2>
        <ol className="dash-body mt-4 list-decimal space-y-3 pl-5 text-foreground/90">
          <li>
            Run <Code>scripts/setup.sh</Code> on your server to generate{" "}
            <Code>server/.dev.vars</Code> with your Cloudflare R2 + Modal keys.
          </li>
          <li>
            Create the R2 buckets and add the S3 CORS rule (see the docs).
          </li>
          <li>
            Deploy the transcoder: <Code>modal deploy main.py</Code> from{" "}
            <Code>transcoding/</Code>, then verify <Code>GET /healthz</Code> on
            the Modal endpoint.
          </li>
          <li>
            Restart the API so it picks up the new environment, then re-check
            this page — everything except the optional flags should be ✓.
          </li>
        </ol>
      </section>
    </div>
  );
}
