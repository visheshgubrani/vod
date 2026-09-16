/**
 * `NEXT_PUBLIC_API_BASE_URL` is the `/api` prefix used by dashboard CRUD
 * (video, upload, keys, webhooks). Every client module resolves it through
 * `API_BASE_URL` below — the single place the fallback lives.
 *
 * The reference must stay a literal `process.env.NEXT_PUBLIC_API_BASE_URL`
 * member expression: Next inlines only literal accesses into the client bundle,
 * so a computed lookup would be `undefined` in the browser and silently send
 * dashboard requests to the origin instead of `/api` (they then 404 without
 * CORS headers, which surfaces as a bare `NetworkError`).
 *
 * Liveness lives on the origin: `GET /health`, `GET /health/config`. Strip a
 * trailing `/api` with `apiOrigin()` so health probes do not 404.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";

export function apiOrigin(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}
