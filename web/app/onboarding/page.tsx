"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Loader2, ArrowRight } from "lucide-react";
import {
  useSession,
  createOrganization,
  setActiveOrganization,
  useListOrganizations,
} from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_NAME } from "@/lib/site";

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const { data: orgsData, isPending: orgsPending } = useListOrganizations();

  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [formData, setFormData] = React.useState({
    name: "",
    slug: "",
  });

  // Redirect to login if not authenticated
  React.useEffect(() => {
    if (!sessionPending && !session) {
      router.push("/login");
    }
  }, [session, sessionPending, router]);

  // Redirect to dashboard if user already has organizations
  React.useEffect(() => {
    if (!orgsPending && orgsData && orgsData.length > 0) {
      router.push("/dashboard");
    }
  }, [orgsData, orgsPending, router]);

  // Auto-generate slug from name
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
        // Set as active organization
        await setActiveOrganization(data.id);
        // Redirect to dashboard
        router.push("/dashboard");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsLoading(false);
    }
  };

  // Show loading state
  if (sessionPending || orgsPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2
            className="size-8 animate-spin text-ember"
            aria-hidden="true"
          />
          <p className="dash-body text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-12 sm:px-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mb-8 flex justify-center">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Image
                src="/logo.svg"
                alt="ClipMux logo"
                width={36}
                height={36}
                className="h-8 w-auto"
                priority
              />
              <span className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
                {APP_NAME}
              </span>
            </Link>
          </div>
          <h1 className="dash-title text-foreground">
            Create Your Organization
          </h1>
          <p className="dash-body mt-2 text-muted-foreground">
            Set up your workspace to start managing videos
          </p>
        </div>

        {/* Form Card */}
        <div className="dash-panel p-5 sm:p-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Error Banner */}
            {error && (
              <div
                role="alert"
                className="rounded-xl border border-failed/30 bg-failed/10 px-4 py-3 text-sm text-danger"
              >
                {error}
              </div>
            )}

            {/* Organization Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Organization Name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Acme Inc"
                value={formData.name}
                onChange={(e) => handleNameChange(e.target.value)}
                disabled={isLoading}
                autoFocus
              />
            </div>

            {/* URL Slug */}
            <div className="space-y-2">
              <Label htmlFor="slug">URL Slug</Label>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-medium text-muted-foreground">
                  clipmux.com/
                </span>
                <Input
                  id="slug"
                  type="text"
                  placeholder="acme"
                  value={formData.slug}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      slug: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, ""),
                    })
                  }
                  disabled={isLoading}
                  className="flex-1"
                />
              </div>
              <p className="dash-meta">
                This will be used in your organization&apos;s URL
              </p>
            </div>

            {/* Submit Button */}
            <Button type="submit" size="lg" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                  Creating...
                </>
              ) : (
                <>
                  Continue to Dashboard
                  <ArrowRight className="size-5" aria-hidden="true" />
                </>
              )}
            </Button>
          </form>
        </div>

        {/* Footer */}
        <p className="dash-meta mt-8 text-center">
          You can invite team members after creating your organization
        </p>
      </div>
    </div>
  );
}
