"use client";

import * as React from "react";
import {
  Loader2,
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  MoreVertical,
  AlertTriangle,
} from "lucide-react";
import { useSession, useActiveOrganization } from "@/lib/auth-client";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardTablePageSkeleton } from "@/components/dashboard/page-skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { API_BASE_URL, apiOrigin } from "@/lib/api-base";

/**
 * Dashboard CRUD base (`<origin>/api`). The public API base used in the snippet
 * below is the origin, not this value — it is a different surface.
 */
const API_URL = API_BASE_URL;
const PUBLIC_API_URL = apiOrigin(API_BASE_URL);

interface ApiKey {
  id: string;
  name: string;
  label?: string | null;
  key_preview: string;
  last_used_at: string | null;
  created_at: string;
}

interface NewKeyResponse {
  id: string;
  name: string;
  key: string;
  key_preview: string;
  message: string;
}

/**
 * The scope label attached to a key at creation time. Rendered at 13px so it is
 * readable rather than legal boilerplate — it is the only thing distinguishing
 * two keys with similar names.
 */
function KeyLabel({ label }: { label: string }) {
  return (
    <span className="mt-1.5 inline-flex max-w-full items-center truncate rounded-full border border-border-soft bg-panel-strong px-2.5 py-0.5 text-[13px] text-muted-foreground">
      {label}
    </span>
  );
}

function ApiKeyActions({
  keyName,
  onRegenerate,
  onRevoke,
}: {
  keyName: string;
  onRegenerate: () => void;
  onRevoke: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${keyName}`}
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-strong hover:text-foreground"
        >
          <MoreVertical className="size-5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[210px] whitespace-nowrap"
      >
        <DropdownMenuItem
          onClick={onRegenerate}
          className="whitespace-nowrap"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Regenerate key
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onRevoke}
          destructive
          className="whitespace-nowrap"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Revoke key
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function ApiKeysPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const { data: activeOrg, isPending: orgPending } = useActiveOrganization();

  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Create key modal
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [newKeyName, setNewKeyName] = React.useState("");
  const [newKeyLabel, setNewKeyLabel] = React.useState("");
  const [isCreating, setIsCreating] = React.useState(false);

  // Newly created key (shown once)
  const [newlyCreatedKey, setNewlyCreatedKey] =
    React.useState<NewKeyResponse | null>(null);
  const [keyCopied, setKeyCopied] = React.useState(false);

  // Delete confirmation
  const [deleteKeyId, setDeleteKeyId] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Regenerate confirmation
  const [regenerateKeyId, setRegenerateKeyId] = React.useState<string | null>(
    null
  );
  const [isRegenerating, setIsRegenerating] = React.useState(false);

  // Fetch API keys
  const fetchKeys = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/keys`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch API keys");
      const data = await res.json();
      setKeys(data.keys || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (session && activeOrg) {
      fetchKeys();
    }
  }, [session, activeOrg, fetchKeys]);

  // Create new key
  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/keys`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName.trim(),
          label: newKeyLabel.trim() || undefined,
        }),
      });

      if (!res.ok) throw new Error("Failed to create API key");

      const data: NewKeyResponse = await res.json();
      setNewlyCreatedKey(data);
      setShowCreateModal(false);
      setNewKeyName("");
      setNewKeyLabel("");
      fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setIsCreating(false);
    }
  };

  // Copy key to clipboard
  const handleCopyKey = async (key: string) => {
    await navigator.clipboard.writeText(key);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  };

  // Delete key
  const handleDeleteKey = async () => {
    if (!deleteKeyId) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`${API_URL}/keys/${deleteKeyId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to delete API key");

      setDeleteKeyId(null);
      fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete API key");
    } finally {
      setIsDeleting(false);
    }
  };

  // Regenerate key
  const handleRegenerateKey = async () => {
    if (!regenerateKeyId) return;

    setIsRegenerating(true);
    try {
      const res = await fetch(`${API_URL}/keys/${regenerateKeyId}/regenerate`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to regenerate API key");

      const data: NewKeyResponse = await res.json();
      setNewlyCreatedKey(data);
      setRegenerateKeyId(null);
      fetchKeys();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to regenerate API key"
      );
    } finally {
      setIsRegenerating(false);
    }
  };

  // Format date
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  // Loading state
  if (sessionPending || orgPending || loading) {
    return <DashboardTablePageSkeleton />;
  }

  if (!session || !activeOrg) {
    return null;
  }

  return (
    <div className="w-full max-w-5xl space-y-8">
      {/* Page Header */}
      <DashboardPageHeader
        title="API keys"
        description="Keys authenticate your applications against the ClipMux API. Create one per service so a single key can be revoked on its own."
        actions={
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Create key
          </Button>
        }
      />

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-failed/35 bg-failed/10 p-4 text-sm text-danger"
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <p>{error}</p>
        </div>
      )}

      {/* One-time secret: the only moment the full key exists in this UI. */}
      {newlyCreatedKey && (
        <section
          aria-labelledby="new-key-title"
          className="dash-panel border-ember/45 p-5 md:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-ember/35 bg-ember/10">
                <Key className="size-5 text-ember" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2
                  id="new-key-title"
                  className="dash-section-title text-foreground"
                >
                  Copy this key now
                </h2>
                <p className="dash-body mt-1.5 max-w-[62ch] text-muted-foreground">
                  This is the only time the full key is shown. Store it in your
                  secret manager before you leave this page — it cannot be
                  displayed again.
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewlyCreatedKey(null)}
            >
              Dismiss
            </Button>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="dash-code-block min-w-0 flex-1 px-4 py-3">
              <code className="dash-code break-all text-foreground">
                {newlyCreatedKey.key}
              </code>
            </div>
            <Button
              size="sm"
              onClick={() => void handleCopyKey(newlyCreatedKey.key)}
              aria-label={
                keyCopied
                  ? "API key copied to clipboard"
                  : "Copy the full API key to the clipboard"
              }
              className="shrink-0"
            >
              {keyCopied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {keyCopied ? "Copied" : "Copy key"}
            </Button>
          </div>

          <p className="dash-meta mt-3">
            Key name:{" "}
            <span className="font-mono text-foreground">
              {newlyCreatedKey.name}
            </span>
          </p>
          <span role="status" className="sr-only">
            {keyCopied ? "API key copied to clipboard" : ""}
          </span>
        </section>
      )}

      {/* API keys list */}
      <section aria-labelledby="key-list-title" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="key-list-title" className="dash-section-title text-foreground">
            Active keys
          </h2>
          {keys.length > 0 && (
            <p className="dash-meta">
              {keys.length} {keys.length === 1 ? "key" : "keys"}
            </p>
          )}
        </div>

        {keys.length === 0 ? (
          <div className="dash-panel flex flex-col items-center px-6 py-14 text-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-border bg-panel-strong text-muted-foreground">
              <Key className="size-6" aria-hidden="true" />
            </span>
            <h3 className="mt-5 text-lg font-semibold text-foreground">
              No API keys yet
            </h3>
            <p className="dash-body mt-2 max-w-sm text-muted-foreground">
              Create a key for each application that calls the API. You will see
              the full secret once, at creation.
            </p>
            <Button
              onClick={() => setShowCreateModal(true)}
              className="mt-6"
            >
              <Plus className="size-4" aria-hidden="true" />
              Create key
            </Button>
          </div>
        ) : (
          <div className="dash-panel overflow-hidden">
            {/* Desktop */}
            <div className="hidden md:block">
              <div className="grid grid-cols-[minmax(0,1fr)_200px_120px_120px_56px] items-center gap-4 border-b border-border px-5 py-3 text-[13px] font-semibold text-muted-foreground">
                <div>Name</div>
                <div>Key</div>
                <div>Last used</div>
                <div>Created</div>
                <div className="sr-only">Actions</div>
              </div>
              <ul className="divide-y divide-border-soft">
                {keys.map((key) => (
                  <li
                    key={key.id}
                    className="grid min-h-[76px] grid-cols-[minmax(0,1fr)_200px_120px_120px_56px] items-center gap-4 px-5 py-3 transition-colors hover:bg-panel-strong/40"
                  >
                    <div className="flex min-w-0 flex-col items-start">
                      <p className="max-w-full truncate text-[15px] font-semibold text-foreground">
                        {key.name}
                      </p>
                      {key.label && <KeyLabel label={key.label} />}
                    </div>
                    <div className="min-w-0">
                      <code className="dash-code block truncate text-muted-foreground">
                        {key.key_preview}
                      </code>
                    </div>
                    <div className="text-[13px] text-muted-foreground">
                      {formatDate(key.last_used_at)}
                    </div>
                    <div className="text-[13px] text-muted-foreground">
                      {formatDate(key.created_at)}
                    </div>
                    <div className="flex justify-end">
                      <ApiKeyActions
                        keyName={key.name}
                        onRegenerate={() => setRegenerateKeyId(key.id)}
                        onRevoke={() => setDeleteKeyId(key.id)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* Mobile */}
            <ul className="divide-y divide-border-soft md:hidden">
              {keys.map((key) => (
                <li key={key.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col items-start">
                      <p className="max-w-full truncate text-[15px] font-semibold text-foreground">
                        {key.name}
                      </p>
                      {key.label && <KeyLabel label={key.label} />}
                    </div>
                    <ApiKeyActions
                      keyName={key.name}
                      onRegenerate={() => setRegenerateKeyId(key.id)}
                      onRevoke={() => setDeleteKeyId(key.id)}
                    />
                  </div>

                  <div className="dash-code-block mt-3 px-3 py-2">
                    <code className="dash-code break-all text-muted-foreground">
                      {key.key_preview}
                    </code>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <dt className="dash-label">Last used</dt>
                      <dd className="mt-1 text-[13px] text-foreground">
                        {formatDate(key.last_used_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="dash-label">Created</dt>
                      <dd className="mt-1 text-[13px] text-foreground">
                        {formatDate(key.created_at)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Usage information */}
      <section className="dash-panel p-5 md:p-6">
        <h2 className="dash-section-title text-foreground">Using your key</h2>
        <p className="dash-body mt-2 max-w-[62ch] text-muted-foreground">
          Send the key in the Authorization header of every request:
        </p>
        <pre className="dash-code-block mt-4 overflow-x-auto p-4">
          <code className="text-foreground">{`curl -H "Authorization: Bearer sk_live_xxxxx" \\
  ${PUBLIC_API_URL}/v1/videos`}</code>
        </pre>
      </section>

      {/* Create key modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-key-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6">
            <h2
              id="create-key-title"
              className="text-lg font-semibold text-foreground"
            >
              Create API key
            </h2>
            <p className="dash-meta mt-1.5">
              Name it after the service that will use it.
            </p>
            <form onSubmit={handleCreateKey} className="mt-5 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="keyName">Name</Label>
                <Input
                  id="keyName"
                  placeholder="Production Key"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  disabled={isCreating}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="keyLabel">Label (optional)</Label>
                <Input
                  id="keyLabel"
                  placeholder="Used by the billing worker"
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  disabled={isCreating}
                />
                <p className="dash-meta">
                  A short note about where this key is used. It is shown beside
                  the key in this list.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreateModal(false)}
                  disabled={isCreating}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isCreating || !newKeyName.trim()}
                  className="flex-1"
                >
                  {isCreating ? (
                    <>
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                      Creating…
                    </>
                  ) : (
                    <>Create key</>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Revoke confirmation */}
      {deleteKeyId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-key-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl border border-failed/35 bg-failed/10">
                <AlertTriangle
                  className="size-5 text-danger"
                  aria-hidden="true"
                />
              </span>
              <h2
                id="revoke-key-title"
                className="text-lg font-semibold text-foreground"
              >
                Revoke this key?
              </h2>
            </div>
            <p className="dash-body mt-4 text-muted-foreground">
              Any application still using this key will immediately lose access.
              This cannot be undone.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setDeleteKeyId(null)}
                className="flex-1"
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteKey}
                disabled={isDeleting}
                className="flex-1"
              >
                {isDeleting ? (
                  <>
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    Revoking…
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Revoke key
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Regenerate confirmation */}
      {regenerateKeyId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="regenerate-key-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl border border-processing/35 bg-processing/10">
                <RefreshCw
                  className="size-5 text-processing"
                  aria-hidden="true"
                />
              </span>
              <h2
                id="regenerate-key-title"
                className="text-lg font-semibold text-foreground"
              >
                Regenerate this key?
              </h2>
            </div>
            <p className="dash-body mt-4 text-muted-foreground">
              A new secret is issued and the current one stops working
              immediately. Any application using the old key must be updated.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setRegenerateKeyId(null)}
                className="flex-1"
                disabled={isRegenerating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleRegenerateKey}
                disabled={isRegenerating}
                className="flex-1"
              >
                {isRegenerating ? (
                  <>
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    Regenerating…
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-4" aria-hidden="true" />
                    Regenerate key
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
