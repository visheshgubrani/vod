"use client";

/**
 * Says out loud what a zeroed chart cannot: this deployment reads playback
 * analytics but has no writer, so nothing is being recorded.
 *
 * The dashboard used to answer `/api/analytics-stats/*` with real zeros, which
 * reads as "nobody watched" — while the API was answering `POST
 * /api/playback/journal` with a 501 that only the browser console ever saw.
 * Writing playback telemetry needs the `PLAYBACK_ANALYTICS` binding, which
 * exists on Cloudflare Workers only, so a Node or container API is a
 * configuration that cannot work rather than one that is misconfigured.
 *
 * Rendered from the capability, never from the data: a notice that appears when
 * a metric is zero would flicker with the numbers.
 */

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDeploymentAnalytics } from "@/lib/use-deployment-analytics";

export function PlaybackAnalyticsNotice({ className }: { className?: string }) {
  const { shape, loading } = useDeploymentAnalytics();

  // Unknown (`null`) is not "disabled" — see the hook.
  if (loading || shape?.analyticsWrite !== "none") return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-xl border border-processing/35 bg-processing/10 p-4 text-sm",
        className,
      )}
    >
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-processing"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          Playback analytics aren’t being recorded
        </p>
        <p className="text-muted-foreground">
          Recording playback telemetry requires the API to run as a Cloudflare
          Worker with the <code className="font-mono text-[0.8125rem]">PLAYBACK_ANALYTICS</code>{" "}
          binding. This deployment has no writer, so the numbers below stay at
          zero. Bandwidth analytics are unaffected — the delivery worker records
          those.
        </p>
      </div>
    </div>
  );
}
