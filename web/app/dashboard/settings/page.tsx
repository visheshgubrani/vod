"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Building2,
  Trash2,
  Save,
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
} from "lucide-react";
import {
  useSession,
  useActiveOrganization,
  updateOrganization,
  deleteOrganization,
} from "@/lib/auth-client";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardSettingsSkeleton } from "@/components/dashboard/page-skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * One settings group: a heading, a one-line description of what the group is
 * for, its fields, and the control that saves them. Fields and their save button
 * stay together so there is never a question of what a button will submit.
 */
function SettingsSection({
  title,
  description,
  icon,
  children,
  footer,
  tone = "default",
  headingId,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  tone?: "default" | "danger";
  headingId: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "dash-panel p-5 md:p-6",
        tone === "danger" && "border-failed/35",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl border",
            tone === "danger"
              ? "border-failed/35 bg-failed/10 text-danger"
              : "border-border bg-panel-strong text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h2 id={headingId} className="dash-section-title text-foreground">
            {title}
          </h2>
          <p className="dash-body mt-1 max-w-[62ch] text-muted-foreground">
            {description}
          </p>
        </div>
      </div>

      {children ? <div className="mt-5">{children}</div> : null}
      {footer ? <div className="mt-6">{footer}</div> : null}
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const { data: activeOrg, isPending: orgPending } = useActiveOrganization();

  const [isUpdating, setIsUpdating] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = React.useState("");

  const [formData, setFormData] = React.useState({
    name: "",
    slug: "",
  });

  // Populate form when org loads
  React.useEffect(() => {
    if (activeOrg) {
      setFormData({
        name: activeOrg.name || "",
        slug: activeOrg.slug || "",
      });
    }
  }, [activeOrg]);

  // Redirect to login if not authenticated
  React.useEffect(() => {
    if (!sessionPending && !session) {
      router.push("/login");
    }
  }, [session, sessionPending, router]);

  // Redirect to onboarding if no active org
  React.useEffect(() => {
    if (!orgPending && !activeOrg) {
      router.push("/onboarding");
    }
  }, [activeOrg, orgPending, router]);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!activeOrg?.id) return;

    if (!formData.name.trim()) {
      setError("Organization name is required");
      return;
    }

    setIsUpdating(true);

    try {
      const { error: updateError } = await updateOrganization({
        organizationId: activeOrg.id,
        name: formData.name.trim(),
        slug: formData.slug.trim() || undefined,
      });

      if (updateError) {
        setError(updateError.message || "Failed to update organization");
      } else {
        setSuccess("Organization updated successfully");
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    if (!activeOrg?.id) return;

    if (deleteConfirmText !== activeOrg.name) {
      setError("Please type the organization name to confirm");
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      const { error: deleteError } = await deleteOrganization(activeOrg.id);

      if (deleteError) {
        setError(deleteError.message || "Failed to delete organization");
        setIsDeleting(false);
      } else {
        // Redirect to onboarding to create a new org
        router.push("/onboarding");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsDeleting(false);
    }
  };

  // Show loading state
  if (sessionPending || orgPending) {
    return <DashboardSettingsSkeleton />;
  }

  if (!session || !activeOrg) {
    return null;
  }

  return (
    <div className="w-full max-w-2xl space-y-8">
      {/* Page Header */}
      <DashboardPageHeader
        title="Settings"
        description="Manage the name and address of this organization, and the workspace itself."
      />

      {/* Save and delete feedback share one region so a result is never missed */}
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
      {success && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-ready/35 bg-ready/10 p-4 text-sm text-ready"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{success}</p>
        </div>
      )}

      {/* Profile */}
      <form onSubmit={handleUpdate}>
        <SettingsSection
          headingId="settings-profile-title"
          title="Organization profile"
          description="How this workspace is named and addressed. Both values appear across the dashboard."
          icon={<Building2 className="size-5" aria-hidden="true" />}
          footer={
            <Button type="submit" disabled={isUpdating}>
              {isUpdating ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" aria-hidden="true" />
                  Save changes
                </>
              )}
            </Button>
          }
        >
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Acme Inc"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                disabled={isUpdating}
              />
              <p className="dash-meta">
                Shown in the workspace switcher and on every invitation.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">URL slug</Label>
              <Input
                id="slug"
                type="text"
                placeholder="acme"
                value={formData.slug}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                  })
                }
                disabled={isUpdating}
              />
              <p className="dash-meta">
                Lowercase letters, numbers and hyphens only.
              </p>
            </div>
          </div>
        </SettingsSection>
      </form>

      {/* Identifiers */}
      <SettingsSection
        headingId="settings-identifier-title"
        title="Identifiers"
        description="Stable values you can paste into support requests and API calls."
        icon={<Fingerprint className="size-5" aria-hidden="true" />}
      >
        <div className="space-y-2">
          <span className="dash-label block">Organization ID</span>
          <p className="dash-code-block px-4 py-3">
            <code className="dash-code break-all text-muted-foreground">
              {activeOrg.id}
            </code>
          </p>
          <p className="dash-meta">
            This ID never changes, even if the name or slug does.
          </p>
        </div>
      </SettingsSection>

      {/* Danger zone */}
      <SettingsSection
        headingId="settings-danger-title"
        title="Danger zone"
        description="Deleting the organization removes every video and key it owns. This cannot be undone."
        icon={<AlertTriangle className="size-5" aria-hidden="true" />}
        tone="danger"
      >
        {!showDeleteConfirm ? (
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            className="border-failed/45 text-danger hover:border-failed/70 hover:bg-failed/10"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete organization
          </Button>
        ) : (
          <div className="dash-panel-quiet space-y-4 border-failed/30 p-4">
            <p className="dash-body text-foreground">
              This action <strong>cannot be undone</strong>. This will
              permanently delete the <strong>{activeOrg.name}</strong>{" "}
              organization and all associated data including videos.
            </p>
            <div className="space-y-2">
              <Label htmlFor="confirm">
                Type <strong>{activeOrg.name}</strong> to confirm
              </Label>
              <Input
                id="confirm"
                type="text"
                placeholder="Type organization name"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                disabled={isDeleting}
              />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                  setError(null);
                }}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting || deleteConfirmText !== activeOrg.name}
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete forever
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
