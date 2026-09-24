/** Session-authenticated client for encoding status, local imports and queue controls. */

import { API_BASE_URL } from "@/lib/api-base";

const API_BASE = API_BASE_URL;

export type LocalWorkerStatus = {
  provider: "local" | "modal";
  modalConfigured: boolean;
  importAvailable: boolean;
  importOrganizationId: string | null;
  worker: null | {
    online: boolean;
    lastSeenAt: string | null;
    hostname: string | null;
    version: string | null;
    capacityJobs: number;
    capacityRenditions: number;
    activeJobs: number;
    encoders: string[];
  };
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
  provider: "local" | "modal";
  attempts: number;
  maxAttempts: number;
  failureCode: string | null;
  lastError: string | null;
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

export const WAITING_REASON_LABELS: Record<string, string> = {
  "worker-offline": "Waiting for this installation's worker",
  "worker-busy": "The local worker is busy",
  "source-missing": "The file is no longer where it was registered",
  "source-changed": "The file changed since it was selected",
  "retry-backoff": "Retrying shortly",
  capacity: "Waiting for capacity",
};

export function waitingReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return WAITING_REASON_LABELS[reason] ?? reason;
}

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
  worker: () => request<LocalWorkerStatus>("/worker"),
  browse: (input: { rootName?: string; path?: string; cursor?: string; limit?: number }) =>
    request<{ controlId: string; expiresAt: string; pollAfterMs: number }>("/browse", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  control: <T>(controlId: string) => request<ControlResult<T>>(`/controls/${controlId}`),
  registerSource: (input: {
    rootName: string;
    relativePath: string;
    fileName: string;
    identity: string;
    sizeBytes: number;
  }) =>
    request<{ sourceRef: string; rootName: string; relativePath: string; fileName: string }>("/sources", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  import: (items: ImportItem[]) =>
    request<{ imports: ImportResult[] }>("/imports", {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  jobs: (limit = 50) => request<{ jobs: TranscoderJob[] }>(`/jobs?limit=${limit}`),
  cancelJob: (jobId: string) =>
    request<{ success: boolean }>(`/jobs/${jobId}/cancel`, { method: "POST", body: "{}" }),
};

/** Browse requests are answered by the local worker on its next poll. */
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
      if (result.response === null) throw new Error("The local worker returned an empty result.");
      return result.response;
    }
    if (result.status === "failed") throw new Error(result.error ?? "The local worker could not read that folder.");
    if (result.status === "expired") throw new Error("The browse request expired. Check that the local worker is online.");
    if (Date.now() >= deadline) throw new Error("The local worker did not respond in time. Check that it is online and connected.");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
