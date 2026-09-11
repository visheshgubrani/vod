/**
 * `NEXT_PUBLIC_API_BASE_URL` is the `/api` prefix used by dashboard CRUD
 * (video, upload, keys). Liveness lives on the origin: `GET /health`,
 * `GET /health/config`. Strip a trailing `/api` so health probes do not 404.
 */
export function apiOrigin(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}
