"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Building2, Trash2, Save, AlertTriangle } from "lucide-react";
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
    <div className="max-w-2xl space-y-8">
      {/* Page Header */}
      <DashboardPageHeader
        title="Settings"
        description="Manage your organization settings"
      />

      {/* Organization Settings Card */}
      <div className="glass rounded-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-sm bg-gradient-to-br from-primary/40 to-accent/40 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Organization
            </h2>
            <p className="text-sm text-muted-foreground">
              Update your organization details
            </p>
          </div>
        </div>

        <form onSubmit={handleUpdate} className="space-y-5">
          {/* Error Banner */}
          {error && (
            <div className="p-3 rounded-sm bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Success Banner */}
          {success && (
            <div className="p-3 rounded-sm bg-lime-500/10 border border-lime-500/20 text-lime-400 text-sm">
              {success}
            </div>
          )}

          {/* Organization ID (readonly) */}
          <div className="space-y-2">
            <Label>Organization ID</Label>
            <Input
              value={activeOrg.id}
              disabled
              className="mt-1.5 rounded-sm bg-foreground/30 font-mono text-sm opacity-60"
            />
          </div>

          {/* Organization Name */}
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
              className="mt-1.5 rounded-sm bg-foreground/30"
            />
          </div>

          {/* URL Slug */}
          <div className="space-y-2">
            <Label htmlFor="slug">URL Slug</Label>
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
              className="mt-1.5 rounded-sm bg-foreground/30"
            />
          </div>

          {/* Submit Button */}
          <Button
            type="submit"
            disabled={isUpdating}
            className="mt-4 rounded-sm"
          >
            {isUpdating ? (
              <>
                <Loader2 className="size-[18px] animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="size-[18px]" />
                Save Changes
              </>
            )}
          </Button>
        </form>
      </div>

      {/* Danger Zone */}
      <div className="rounded-sm border border-destructive/20 bg-red-500/5 p-6">
        <div className="flex items-center gap-3 mb-10">
          <div className="size-11 rounded-sm bg-destructive/15 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-foreground">Danger Zone</h2>
            <p className="text-sm text-muted-foreground">
              Proceed carefully. These actions cannot be undone.
            </p>
          </div>
        </div>

        {!showDeleteConfirm ? (
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            className="rounded-sm border-destructive/50 hover:border-red-800 text-red-400 font-medium hover:bg-destructive/10"
          >
            <Trash2 className="size-[16px]" />
            Delete Organization
          </Button>
        ) : (
          <div className="space-y-4 rounded-sm border border-destructive/20 bg-destructive/5 p-4">
            <p className="text-sm text-foreground">
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
                className="mt-1.5 rounded-sm bg-foreground/30"
              />
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                  setError(null);
                }}
                disabled={isDeleting}
                className="rounded-sm"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDelete}
                disabled={isDeleting || deleteConfirmText !== activeOrg.name}
                className="rounded-sm bg-destructive hover:bg-destructive/90"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="size-[18px] animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="size-[18px]" />
                    Delete Forever
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
