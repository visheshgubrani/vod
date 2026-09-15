"use client";

import * as React from "react";
import { ArrowRight, Building2, Loader2, AlertTriangle } from "lucide-react";
import {
  createOrganization,
  setActiveOrganization,
} from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface CreateOrganizationModalProps {
  open: boolean;
  onClose: () => void;
}

export function CreateOrganizationModal({
  open,
  onClose,
}: CreateOrganizationModalProps) {
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [formData, setFormData] = React.useState({
    name: "",
    slug: "",
  });

  React.useEffect(() => {
    if (!open) {
      setIsLoading(false);
      setError(null);
      setFormData({ name: "", slug: "" });
    }
  }, [open]);

  const handleNameChange = (name: string) => {
    setFormData({
      name,
      slug: name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 50),
    });
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!formData.name.trim()) {
      setError("Organization name is required");
      return;
    }

    if (!formData.slug.trim()) {
      setError("URL slug is required");
      return;
    }

    setIsLoading(true);

    try {
      const { data, error: createError } = await createOrganization({
        name: formData.name.trim(),
        slug: formData.slug.trim(),
      });

      if (createError) {
        setError(createError.message || "Failed to create organization");
        setIsLoading(false);
        return;
      }

      if (data?.id) {
        await setActiveOrganization(data.id);
        onClose();
        return;
      }

      setError("Organization was created, but no organization ID was returned");
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsLoading(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label="Create organization"
      className="w-full max-w-none border-l border-border bg-panel-quiet sm:w-[min(34rem,100vw)]"
    >
      <SheetHeader className="pr-16">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-brand/40 bg-brand text-brand-foreground">
            <Building2 className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <SheetTitle className="text-xl">Create organization</SheetTitle>
            <p className="dash-body mt-1.5 max-w-[62ch] text-muted-foreground">
              Add another workspace without leaving the dashboard. You will be
              switched to it as soon as it exists.
            </p>
          </div>
        </div>
      </SheetHeader>

      <SheetContent className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
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

          <div className="space-y-2">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              type="text"
              placeholder="Acme Inc"
              value={formData.name}
              onChange={(event) => handleNameChange(event.target.value)}
              disabled={isLoading}
              autoFocus
            />
            <p className="dash-meta">
              Shown in the workspace switcher. The URL slug is filled in from it.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-slug">URL slug</Label>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-[15px] text-muted-foreground">
                clipmux.com/
              </span>
              <div className="min-w-0 flex-1">
                <Input
                  id="org-slug"
                  type="text"
                  placeholder="acme"
                  value={formData.slug}
                  onChange={(event) =>
                    setFormData((current) => ({
                      ...current,
                      slug: event.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, ""),
                    }))
                  }
                  disabled={isLoading}
                  className="font-mono"
                />
              </div>
            </div>
            <p className="dash-meta">
              Lowercase letters, numbers and hyphens only. This becomes the
              workspace URL slug.
            </p>
          </div>

          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                <>
                  Create organization
                  <ArrowRight className="size-4" aria-hidden="true" />
                </>
              )}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
