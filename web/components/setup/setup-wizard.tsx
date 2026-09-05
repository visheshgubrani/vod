"use client";

import * as React from "react";

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

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";

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
      const res = await fetch(`${API_BASE.replace(/\/$/, "")}/health/config`, {
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
    <div className="mt-8 space-y-6">
      {/* API reachability */}
      <section className="rounded-xl border p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">API reachability</h2>
          <span
            className={
              apiState === "ok"
                ? "text-emerald-500"
                : apiState === "loading"
                  ? "text-amber-500"
                  : "text-red-500"
            }
          >
            {apiState === "ok"
              ? "● reachable"
              : apiState === "loading"
                ? "● probing…"
                : "● unreachable"}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {API_BASE} — is the API worker/container running?
        </p>
        {apiState === "down" && (
          <p className="mt-2 text-sm text-red-500">
            Could not reach the API at {API_BASE}. Start it with{" "}
            <code>wrangler dev</code> (server package) or{" "}
            <code>docker compose up -d</code>.
          </p>
        )}
        {error && apiState === "ok" && (
          <p className="mt-2 text-sm text-amber-600">Config parse: {error}</p>
        )}
        <button
          onClick={() => void check()}
          className="mt-3 rounded-md border px-3 py-1.5 text-sm"
        >
          Re-check
        </button>
      </section>

      {/* Capability checks */}
      {config && (
        <section className="rounded-xl border p-5">
          <h2 className="font-medium">Configured capabilities</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {(Object.keys(CHECK_LABELS) as Array<keyof HealthConfig["checks"]>).map(
              (key) => {
                const ok = config.checks[key];
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                  >
                    <span>{CHECK_LABELS[key]}</span>
                    <span className={ok ? "text-emerald-500" : "text-red-500"}>
                      {ok ? "✓ configured" : "✗ missing"}
                    </span>
                  </li>
                );
              },
            )}
          </ul>
          {config.problems.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm text-amber-600">
              {config.problems.map((problem) => (
                <li key={problem}>• {problem}</li>
              ))}
            </ul>
          )}
          {config.advisories?.map((advisory) => (
            <p key={advisory} className="mt-1 text-xs text-muted-foreground">
              {advisory}
            </p>
          ))}
        </section>
      )}

      {/* Next steps */}
      <section className="rounded-xl border p-5">
        <h2 className="font-medium">Next steps</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>
            Run <code>scripts/setup.sh</code> on your server to generate{" "}
            <code>server/.dev.vars</code> with your Cloudflare R2 + Modal keys.
          </li>
          <li>
            Create the R2 buckets and add the S3 CORS rule (see the docs).
          </li>
          <li>
            Deploy the transcoder: <code>modal deploy main.py</code> from{" "}
            <code>transcoding/</code>, then verify{" "}
            <code>GET /healthz</code> on the Modal endpoint.
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
