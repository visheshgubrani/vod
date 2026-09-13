"use client";

import { TranscodersPanel } from "@/components/dashboard/transcoders-panel";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { useActiveOrganization } from "@/lib/auth-client";

/**
 * Encoders on the owner's own machines.
 *
 * Two distinctions this page has to make, both of which are invisible until they
 * cause a support ticket:
 *
 * 1. **Browser files vs. machine files.** An "upload" reads the browser's disk;
 *    an "import" reads the agent's. The panel says so in the empty state and
 *    above the browser.
 * 2. **This page is not about Modal.** Pairing a machine adds a provider; it does
 *    not replace one. Jobs show which provider ran them, because "why was this
 *    slow?" has a different answer for each.
 */
export default function TranscodersPage() {
  const { data: activeOrg, isPending } = useActiveOrganization();

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <DashboardPageHeader
        title="Transcoders"
        description="Encode on your own hardware and import files that never leave your network."
      />

      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !activeOrg ? (
        <p className="text-sm text-muted-foreground">
          Select an organization to manage its transcoders.
        </p>
      ) : (
        <TranscodersPanel />
      )}
    </div>
  );
}
