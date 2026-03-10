"use client";

import * as React from "react";
import { ArrowRight, Building2, Loader2 } from "lucide-react";
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
      <SheetContent className="w-full sm:max-w-xl border-l border-border bg-background/95 backdrop-blur-xl">
        <SheetHeader className="border-b border-border pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent shadow-md">
              <Building2 className="h-5 w-5 text-white" />
            </div>
            <div>
              <SheetTitle>Create Organization</SheetTitle>
              <p className="text-sm text-muted-foreground">
                Add another workspace without leaving the dashboard.
              </p>
            </div>
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
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-slug">URL Slug</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">clipmux.io/</span>
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
                className="flex-1"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This becomes the workspace URL slug.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
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
