"use client";

import * as React from "react";
import {
  Loader2,
  Webhook,
  Plus,
  Copy,
  Check,
  Trash2,
  MoreVertical,
  Eye,
  EyeOff,
  AlertTriangle,
} from "lucide-react";
import { useSession, useActiveOrganization } from "@/lib/auth-client";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardTablePageSkeleton } from "@/components/dashboard/page-skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { API_BASE_URL } from "@/lib/api-base";

const API_URL = API_BASE_URL;

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[] | null;
  enabled: boolean;
  description: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
}

interface NewWebhookResponse {
  id: string;
  url: string;
  secret: string;
  events: string[];
  message: string;
}

function WebhookActions({
  onDelete,
  url,
}: {
  onDelete: () => void;
  url: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${url}`}
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-strong hover:text-foreground"
        >
          <MoreVertical className="size-5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px] whitespace-nowrap"
      >
        <DropdownMenuItem onClick={onDelete} destructive>
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Enabled/disabled switch: 44px hit target, real switch semantics. */
function WebhookToggle({
  enabled,
  url,
  isToggling,
  onToggle,
}: {
  enabled: boolean;
  url: string;
  isToggling: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "Disable" : "Enable"} webhook ${url}`}
      onClick={onToggle}
      disabled={isToggling}
      className="inline-flex h-11 w-14 items-center justify-center rounded-lg transition-colors hover:bg-panel-strong disabled:opacity-50"
    >
      <span
        className={cn(
          "relative block h-6 w-12 rounded-full border transition-colors",
          enabled
            ? "border-brand bg-brand"
            : "border-border bg-panel-strong"
        )}
      >
        <span
          className={cn(
            "absolute top-1 left-1 size-4 rounded-full bg-white transition-transform",
            enabled && "translate-x-6"
          )}
        />
      </span>
    </button>
  );
}

export default function WebhooksPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const { data: activeOrg, isPending: orgPending } = useActiveOrganization();

  const [webhooks, setWebhooks] = React.useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Create modal
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [newUrl, setNewUrl] = React.useState("");
  const [isCreating, setIsCreating] = React.useState(false);

  // Newly created webhook (shown once with secret)
  const [newlyCreated, setNewlyCreated] =
    React.useState<NewWebhookResponse | null>(null);
  const [secretCopied, setSecretCopied] = React.useState(false);
  const [secretVisible, setSecretVisible] = React.useState(false);

  // Delete confirmation
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Toggle enabled
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  // Fetch webhooks
  const fetchWebhooks = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/webhooks`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch webhooks");
      const data = await res.json();
      setWebhooks(data.endpoints || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (session && activeOrg) {
      fetchWebhooks();
    }
  }, [session, activeOrg, fetchWebhooks]);

  // Create new webhook
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) return;

    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/webhooks`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: newUrl.trim(),
          events: [
            "video.uploading",
            "video.uploaded",
            "video.ready",
            "video.failed",
            "video.updated",
            "video.deleted",
            "subtitle.generated",
            "chapters.generated",
          ],
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to create webhook");
      }

      const data: NewWebhookResponse = await res.json();
      setNewlyCreated(data);
      setShowCreateModal(false);
      setNewUrl("");
      fetchWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setIsCreating(false);
    }
  };

  // Copy secret
  const handleCopySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
  };

  // Toggle enabled
  const handleToggle = async (id: string, currentEnabled: boolean) => {
    setTogglingId(id);
    try {
      const res = await fetch(`${API_URL}/webhooks/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (!res.ok) throw new Error("Failed to update webhook");
      fetchWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle webhook");
    } finally {
      setTogglingId(null);
    }
  };

  // Delete webhook
  const handleDelete = async () => {
    if (!deleteId) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`${API_URL}/webhooks/${deleteId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete webhook");
      setDeleteId(null);
      fetchWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete webhook");
    } finally {
      setIsDeleting(false);
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
        title="Webhooks"
        description="Configure outbound event delivery for your organization."
        actions={
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="size-5" aria-hidden="true" />
            Create webhook
          </Button>
        }
      />

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-failed/35 bg-failed/10 p-4 text-sm text-danger"
        >
          {error}
        </div>
      )}

      {/* Newly Created Webhook Banner */}
      {newlyCreated && (
        <section className="dash-panel border-ready/40 bg-ready/5 p-5 md:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-ready/35 bg-ready/10 text-ready">
              <Webhook className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="dash-section-title text-foreground">
                Webhook created
              </h2>
              <p className="dash-body mt-1.5 max-w-2xl text-muted-foreground">
                Save your signing secret now. It is shown once and cannot be
                retrieved again.
              </p>
              <p className="dash-meta mt-3 break-all font-mono text-foreground">
                {newlyCreated.url}
              </p>
              <div className="dash-code-block mt-3 flex items-center gap-2 p-3">
                <code className="min-w-0 flex-1 break-all text-foreground">
                  {secretVisible ? newlyCreated.secret : "•".repeat(40)}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={
                    secretVisible
                      ? "Hide signing secret"
                      : "Show signing secret"
                  }
                  onClick={() => setSecretVisible(!secretVisible)}
                >
                  {secretVisible ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Copy signing secret"
                  onClick={() => handleCopySecret(newlyCreated.secret)}
                >
                  {secretCopied ? (
                    <Check className="size-4 text-ready" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setNewlyCreated(null)}
            >
              Dismiss
            </Button>
          </div>
        </section>
      )}

      {/* Webhooks list */}
      <section className="dash-panel overflow-hidden">
        {webhooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-border bg-panel-strong text-muted-foreground">
              <Webhook className="size-6" aria-hidden="true" />
            </span>
            <h2 className="mt-5 text-lg font-semibold text-foreground">
              No webhooks yet
            </h2>
            <p className="dash-body mt-2 max-w-md text-muted-foreground">
              Add an endpoint to receive signed event notifications when your
              videos change state.
            </p>
            <Button
              onClick={() => setShowCreateModal(true)}
              className="mt-6"
            >
              <Plus className="size-4" aria-hidden="true" />
              Create webhook
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border-soft">
            {webhooks.map((wh) => (
              <li key={wh.id} className="flex flex-col gap-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <a
                      href={wh.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block break-all font-mono text-[15px] font-semibold text-ember transition-colors hover:underline"
                    >
                      {wh.url}
                    </a>
                    {wh.description ? (
                      <p className="dash-meta mt-1.5">{wh.description}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={wh.enabled ? "ready" : "neutral"}>
                      <span
                        className={cn(
                          "dash-dot",
                          wh.enabled ? "bg-ready" : "bg-idle"
                        )}
                        aria-hidden="true"
                      />
                      {wh.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <WebhookToggle
                      enabled={wh.enabled}
                      url={wh.url}
                      isToggling={togglingId === wh.id}
                      onToggle={() => handleToggle(wh.id, wh.enabled)}
                    />
                    <WebhookActions
                      url={wh.url}
                      onDelete={() => setDeleteId(wh.id)}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <p className="dash-label">Events</p>
                  {wh.events && wh.events.length > 0 ? (
                    <ul className="flex flex-wrap gap-2">
                      {wh.events.map((event) => (
                        <li key={event}>
                          <Badge
                            variant="secondary"
                            className="font-mono text-[13px]"
                          >
                            {event}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="dash-meta">
                      No events subscribed — this endpoint will not receive
                      deliveries.
                    </p>
                  )}
                </div>

                <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Last delivery</dt>
                    <dd className="font-medium text-foreground">
                      {formatDate(wh.lastTriggeredAt)}
                    </dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Created</dt>
                    <dd className="font-medium text-foreground">
                      {formatDate(wh.createdAt)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Create Webhook Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-webhook-title"
            className="w-full max-w-md rounded-2xl border border-border bg-panel p-6"
          >
            <h2
              id="create-webhook-title"
              className="text-lg font-semibold text-foreground"
            >
              Create webhook
            </h2>
            <form onSubmit={handleCreate} className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="webhookUrl">Endpoint URL</Label>
                <Input
                  id="webhookUrl"
                  type="url"
                  placeholder="https://your-server.com/webhook"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  autoFocus
                  className="mt-1.5"
                />
                <p className="dash-meta">
                  HTTPS is required, except for localhost endpoints.
                </p>
              </div>
              <div className="flex flex-col gap-2 pt-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isCreating || !newUrl.trim()}
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
                    "Create"
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-webhook-title"
            className="w-full max-w-md rounded-2xl border border-border bg-panel p-6"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl border border-failed/35 bg-failed/10">
                <AlertTriangle
                  className="size-5 text-danger"
                  aria-hidden="true"
                />
              </span>
              <h2
                id="delete-webhook-title"
                className="text-lg font-semibold text-foreground"
              >
                Delete this webhook?
              </h2>
            </div>
            <p className="dash-body mt-4 text-muted-foreground">
              Deliveries to this endpoint stop immediately, and its delivery
              log is removed. This cannot be undone.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setDeleteId(null)}
                className="flex-1"
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1"
              >
                {isDeleting ? (
                  <>
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete webhook
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
