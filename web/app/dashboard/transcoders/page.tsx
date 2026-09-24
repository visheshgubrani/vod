"use client";

import { TranscodersPanel } from "@/components/dashboard/transcoders-panel";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { useActiveOrganization } from "@/lib/auth-client";

/**
 * Deployment-wide encoding provider plus the active organization's job queue.
 * Host-folder browsing is an optional local-worker feature; ordinary uploads
 * remain available to every organization.
 */
export default function TranscodersPage() {
  const { data: activeOrg, isPending } = useActiveOrganization();

  return (
    <div className="w-full space-y-8">
      <DashboardPageHeader
        title="Encoding"
        description="See the provider for new videos and manage your organization’s encoding queue. Local file import appears when enabled."
      />

      {isPending ? (
        <p className="dash-body text-muted-foreground">Loading…</p>
      ) : !activeOrg ? (
        <p className="dash-body text-muted-foreground">
          Select an organization to view its encoding queue.
        </p>
      ) : (
        <TranscodersPanel activeOrganizationId={activeOrg.id} />
      )}
    </div>
  );
}
