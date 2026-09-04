"use client";

import * as React from "react";
import { ArrowRight, Building2, Loader2, X } from "lucide-react";
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
    <Sheet open={open} onClose={onClose}>
      <SheetContent className="w-full md:p-6 p-3 -mt-2 sm:max-w-xl border-l border-border bg-background/95 backdrop-blur-xl">
        <SheetHeader className="border-b border-border px-2 pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-11 items-center justify-center rounded-md bg-gradient-to-br from-primary to-accent p-2 shadow-md">
                <Building2 className="h-5 w-5 text-white" />
              </div>
              <div>
                <SheetTitle>Create Organization</SheetTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add another workspace without leaving the dashboard.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label="Close create organization modal"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="space-y-5 px-1 py-6">
          {error && (
            <div className="rounded-sm border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="org-name">Organization Name</Label>
            <Input
              id="org-name"
              type="text"
              placeholder="Acme Inc"
              value={formData.name}
              onChange={(event) => handleNameChange(event.target.value)}
              disabled={isLoading}
              autoFocus
              className="mt-2 rounded-md bg-muted-foreground/20"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-slug">URL Slug</Label>
            <div className="flex items-center mt-2 gap-2">
              <span className="text-sm text-accent font-medium">openvod.dev/</span>
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
                className="flex-1 h-10 rounded-md bg-muted-foreground/20"

              />
            </div>
            <p className="text-xs text-muted-foreground/80 mt-1">
              This becomes the workspace URL slug.
            </p>
          </div>

          <div className="flex pt-4 flex-col gap-4">
            <Button
              type="button"
              variant="outline"
              className="flex-1 py-3"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1 py-3" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  Create Organization
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
