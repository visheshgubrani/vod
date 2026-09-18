"use client";

/**
 * Says out loud what a zeroed chart cannot: analytics are off or cannot be
 * forwarded, so the numbers below are not usage.
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
  if (loading || !shape || shape.analyticsWrite !== "none") return null;

  const disabled = shape.analyticsEnabled === false;

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
          {disabled
            ? "Analytics are disabled"
            : "Playback analytics aren’t available"}
        </p>
        <p className="text-muted-foreground">
          {disabled
            ? "ANALYTICS_ENABLED is off for this deployment, so playback and bandwidth events are not collected. The numbers below are not usage. Media delivery is unaffected."
            : "This API cannot forward playback telemetry to the delivery worker (missing DELIVERY_URL or ANALYTICS_INGEST_SECRET). The numbers below stay at zero and are not usage."}
        </p>
      </div>
    </div>
  );
}
