import type { ReactNode } from "react";

/**
 * The four states a video row can be in, matching the API's lifecycle
 * (`lib/videoState.ts` on the server). The label is always text — the colour is
 * a reinforcement, never the only signal.
 */
export type StatusState = "ready" | "processing" | "uploading" | "failed";

export function StatusChip({
  state,
  children,
}: {
  state: StatusState;
  children: ReactNode;
}) {
  return (
    <span className="status-chip" data-state={state}>
      {children}
    </span>
  );
}
