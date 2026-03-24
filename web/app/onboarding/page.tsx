"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Building2, ArrowRight } from "lucide-react";
import {
  useSession,
  createOrganization,
  setActiveOrganization,
  useListOrganizations,
} from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import Image from "next/image";

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
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="mb-2">
            <Link href="/" className="flex items-center gap-1.5 justify-center">
              <Image
                src="/logo.svg"
                alt="ClipMux logo"
                width={36}
                height={36}
                className="h-12 w-auto"
                priority
              />
              {/* <span className="text-2xl tracking-wider text-purple-200 font-dashboard-heading">
                ClipMux
              </span> */}
            </Link>
          </div>
          <h1 className="text-2xl mt-4 font-medium text-foreground mb-1.5">
            Create Your Organization
          </h1>
          <p className="text-muted-foreground">
            Set up your workspace to start managing videos
          </p>
        </div>

        {/* Form Card */}
        <div className="glass rounded-md p-4 lg:p-6">
          <form onSubmit={handleSubmit} className="space-y-7">
            {/* Error Banner */}
            {error && (
              <div className="p-3 rounded-sm bg-destructive/10 border border-destructive/20 text-destructive text-sm">
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
                className="mt-2 rounded-md bg-muted-foreground/20"
              />
            </div>

            {/* URL Slug */}
            <div className="space-y-2">
              <Label htmlFor="slug">URL Slug</Label>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-sm text-accent font-medium">clipmux.io/</span>
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
                  className="flex-1 rounded-md bg-muted-foreground/20 h-10"
                />
              </div>
              <p className="text-xs text-muted-foreground/80">
                This will be used in your organization&apos;s URL
              </p>
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              className="w-full mt-3 lg:text-base text-sm"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  Continue to Dashboard
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </Button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground/80 mt-8">
          You can invite team members after creating your organization
        </p>
      </div>
    </div>
  );
}
