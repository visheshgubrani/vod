/**
 * Client for the dashboard's transcoder routes (`/api/transcoder/*`).
 *
 * Two things this module exists to keep in one place:
 *
 * 1. **The distinction the UI must make.** "Upload a file" reads the *browser's*
 *    machine. "Import from transcoder" reads files on the *agent's* machine.
 *    They are different filesystems, and a UI that blurs them produces a support
 *    ticket every time. The types below keep them apart.
 * 2. **Browsing is asynchronous.** The agent has no listener, so a folder listing
 *    is a request the agent collects on its next poll. Callers get a
 *    `pollControl` helper rather than a promise that hangs for 30 seconds.
 *
 * Session-authenticated: these routes use the dashboard cookie, not an API key.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";

export type AgentHealth = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  hostname: string | null;
  agentVersion: string | null;
  enabled: boolean;
  capacityJobs: number;
  capacityRenditions: number;
  encoders: string[];
  scratchFreeBytes: number | null;
  probedAt: string | null;
  tokenLast4: string;
  activeJobs: number;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  mediaType: string;
  identity: string;
};

export type DirectoryListing = {
  root: string;
  path: string;
  entries: DirectoryEntry[];
  nextCursor: string;
  roots?: Array<{ name: string }>;
};

export type ControlStatus = "pending" | "delivered" | "completed" | "failed" | "expired";

export type ControlResult<T> = {
  id: string;
  kind: string;
  status: ControlStatus;
  response: T | null;
  error: string | null;
};

export type TranscoderJob = {
  jobId: string;
  videoId: string;
  title: string;
  status: string;
  state: string;
  waitingReason: string | null;
  provider: string;
  attempts: number;
  maxAttempts: number;
  failureCode: string | null;
  lastError: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ImportItem = {
  sourceRef: string;
  title?: string;
  playbackPolicy?: "public" | "signed";
  processingOptions?: Record<string, unknown>;
  generateSubtitle?: boolean;
  generateChapters?: boolean;
  idempotencyKey?: string;
};

export type ImportResult = {
  videoId: string;
  jobId: string;
  title: string;
  sourceRef: string;
  status: string;
  waitingReason: string | null;
  deduplicated: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/transcoder${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

/**
 * Waiting reason → what the owner should do about it.
 *
 * Rendered verbatim next to a queued job. "Queued" alone tells an owner nothing;
 * "waiting for the machine that holds this file" tells them to turn that machine
 * on, and "this file changed" tells them to re-select it.
 */
export const WAITING_REASON_LABELS: Record<string, string> = {
  "agent-offline": "Waiting for the machine that holds this file",
  "agent-busy": "The machine is busy with another job",
  "source-missing": "The file is no longer where it was registered",
  "source-changed": "The file changed since it was selected",
  "no-eligible-agent": "No machine can read this file — re-select it",
  "retry-backoff": "Retrying shortly",
  capacity: "Waiting for capacity",
};

export function waitingReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return WAITING_REASON_LABELS[reason] ?? reason;
}

/** Encoder backend → what it means to an owner. */
export const ENCODER_LABELS: Record<string, string> = {
  nvenc: "NVIDIA (NVENC)",
  vaapi: "AMD / Intel (VAAPI)",
  cpu: "CPU (software)",
};

export function encoderLabel(name: string): string {
  return ENCODER_LABELS[name] ?? name;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export const transcoderApi = {
  listAgents: () => request<{ agents: AgentHealth[] }>("/agents"),

  createPairing: (name?: string) =>
    request<{ pairingId: string; code: string; expiresAt: string; command: string }>(
      "/pairings",
      { method: "POST", body: JSON.stringify({ name }) },
    ),

  updateAgent: (
    agentId: string,
    patch: Partial<Pick<AgentHealth, "name" | "enabled" | "capacityJobs" | "capacityRenditions">>,
  ) => request<{ success: boolean }>(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(patch) }),

  revokeAgent: (agentId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}`, { method: "DELETE" }),

  browse: (agentId: string, input: { rootName?: string; path?: string; cursor?: string; limit?: number }) =>
    request<{ controlId: string; expiresAt: string; pollAfterMs: number }>(
      `/agents/${agentId}/browse`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  control: <T>(controlId: string) => request<ControlResult<T>>(`/controls/${controlId}`),

  registerSource: (input: {
    agentId: string;
    rootName: string;
    relativePath: string;
    fileName: string;
    identity: string;
    sizeBytes: number;
  }) =>
    request<{ sourceRef: string; rootName: string; relativePath: string; fileName: string }>(
      "/sources",
      { method: "POST", body: JSON.stringify(input) },
    ),

  import: (items: ImportItem[]) =>
    request<{ imports: ImportResult[] }>("/imports", {
      method: "POST",
      body: JSON.stringify({ items }),
    }),

  jobs: (limit = 50) => request<{ jobs: TranscoderJob[] }>(`/jobs?limit=${limit}`),

  cancelJob: (jobId: string) =>
    request<{ success: boolean }>(`/jobs/${jobId}/cancel`, { method: "POST", body: "{}" }),

  health: () =>
    request<{ agents: AgentHealth[]; queue: Record<string, number>; waitingReasons: string[] }>("/health"),
};

/**
 * Poll an asynchronous control request until it settles.
 *
 * The agent collects work on its own schedule, so a browse legitimately takes a
 * few seconds. A timeout is reported as a timeout rather than as an empty folder,
 * because "your machine did not answer" and "that folder is empty" call for
 * different actions.
 */
export async function pollControl<T>(
  controlId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 700;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await transcoderApi.control<T>(controlId);

    if (result.status === "completed") {
      if (!result.response) throw new Error("The machine returned no listing");
      return result.response;
    }
    if (result.status === "failed") {
      throw new Error(result.error || "The machine could not complete that request");
    }
    if (result.status === "expired" || Date.now() > deadline) {
      throw new Error(
        "The machine did not respond in time. Check that the agent is running and connected.",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
