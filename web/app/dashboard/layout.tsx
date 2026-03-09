"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
    useSession,
    useListOrganizations,
    useActiveOrganization,
    setActiveOrganization,
} from "@/lib/auth-client";
import { DashboardSidebar } from "@/components/dashboard/dashboard-sidebar";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardLayoutSkeleton } from "@/components/dashboard/page-skeletons";
import { UploadModal } from "@/components/dashboard/upload-modal";

interface DashboardLayoutProps {
    children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
    const router = useRouter();
    const { data: session, isPending: sessionPending } = useSession();
    const { data: organizations, isPending: orgsPending } = useListOrganizations();
    const { data: activeOrg } = useActiveOrganization();
    const [uploadModalOpen, setUploadModalOpen] = React.useState(false);
    const [hasResolvedActiveOrg, setHasResolvedActiveOrg] = React.useState(false);

    React.useEffect(() => {
        if (activeOrg !== undefined) {
            setHasResolvedActiveOrg(true);
        }
    }, [activeOrg]);

    // Redirect to login if not authenticated
    React.useEffect(() => {
        if (!sessionPending && !session) {
            router.push("/login");
        }
    }, [session, sessionPending, router]);

    // Redirect to onboarding if user has no organizations
    React.useEffect(() => {
        if (!orgsPending && organizations && organizations.length === 0) {
            router.push("/onboarding");
        }
    }, [organizations, orgsPending, router]);

    // Auto-set active org if none is set but orgs exist
    React.useEffect(() => {
        if (
            !orgsPending &&
            hasResolvedActiveOrg &&
            organizations &&
            organizations.length > 0 &&
            !activeOrg
        ) {
            setActiveOrganization(organizations[0].id);
        }
    }, [organizations, orgsPending, activeOrg, hasResolvedActiveOrg]);

    // Handle upload completion
    const handleUploadComplete = React.useCallback((fileId: string, key: string) => {
        console.log("Upload complete:", { fileId, key });
        // Refresh the page to show new video
        router.refresh();
    }, [router]);

    // Handle organization change
    const handleOrgChange = React.useCallback(async (orgId: string | null) => {
        if (orgId) {
            await setActiveOrganization(orgId);
        }
    }, []);

    // Show loading state
    if (sessionPending || orgsPending) {
        return <DashboardLayoutSkeleton />;
    }

    // Don't render if not authenticated
    if (!session) {
        return null;
    }

    // Don't render if no organizations (will redirect to onboarding)
    if (!organizations || organizations.length === 0) {
        return null;
    }

    // Map organizations to the format expected by sidebar
    const sidebarOrgs = organizations.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo: org.logo ?? undefined,
    }));

    return (
        <div className="flex h-screen bg-background overflow-hidden">
            {/* Sidebar */}
            <DashboardSidebar
                userName={session.user?.name}
                organizations={sidebarOrgs}
                activeOrgId={activeOrg?.id ?? null}
                onOrgChange={handleOrgChange}
                onUploadClick={() => setUploadModalOpen(true)}
            />

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                <DashboardHeader
                    userName={session.user?.name}
                    userEmail={session.user?.email}
                    userImage={session.user?.image}
                    organizationName={activeOrg?.name ?? organizations[0]?.name ?? "Organization"}
                />
                <main className="relative z-0 flex-1 overflow-auto p-6">
                    {children}
                </main>
            </div>

            {/* Upload Modal */}
            <UploadModal
                open={uploadModalOpen}
                onClose={() => setUploadModalOpen(false)}
                onUploadComplete={handleUploadComplete}
            />
        </div>
    );
}
