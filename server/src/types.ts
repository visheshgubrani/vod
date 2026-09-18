/**
 * Hono bindings for the Node API.
 *
 * The app reads configuration from `c.var.runtime`, not from these bindings.
 * The Node request handler still passes `process.env` as the second `fetch`
 * argument, so the generic stays a string map.
 */
export type Bindings = Record<string, string | undefined>

// Context variables set by API key middleware
export type ApiKeyVariables = {
  organizationId: string
  apiKeyId: string
  userId: string
}

// Context variables set by upload token middleware
export type UploadTokenVariables = {
  organizationId: string
  uploadTokenId: string
  uploadTokenRecord: {
    id: string
    token: string
    organizationId: string
    apiKeyId: string | null
    maxFiles: number | null
    usedFiles: number | null
    maxSizeBytes: number | null
    expiresAt: Date
    createdAt: Date | null
  }
}
