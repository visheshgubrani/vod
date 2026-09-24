"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BarChart3,
  Settings,
  ChevronDown,
  Key,
  HardDrive,
  Webhook,
  ServerCog,
  Upload,
  Check,
} from "lucide-react";
import { CreateOrganizationModal } from "@/components/dashboard/create-organization-modal";
import { cn } from "@/lib/utils";

interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string;
}

interface DashboardSidebarProps {
  userName?: string;
  organizations?: Organization[];
  activeOrgId?: string | null;
  onOrgChange?: (orgId: string | null) => void;
  onUploadClick?: () => void;
}

const navItems = [
  { href: "/dashboard", label: "Library", icon: LayoutDashboard },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/usage", label: "Usage", icon: HardDrive },
  { href: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/dashboard/api-keys", label: "API keys", icon: Key },
  { href: "/dashboard/transcoders", label: "Encoding", icon: ServerCog },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

function OrgMark({ name, className }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "O";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-strong text-[13px] font-bold text-ember",
        className,
      )}
    >
      {initial}
    </span>
  );
}

export function DashboardSidebar({
  organizations = [],
  activeOrgId,
  onOrgChange,
  onUploadClick,
}: DashboardSidebarProps) {
  const pathname = usePathname();
  const [isOrgSwitcherOpen, setIsOrgSwitcherOpen] = React.useState(false);
  const [isCreateOrgOpen, setIsCreateOrgOpen] = React.useState(false);

  const activeOrg =
    organizations.find((org) => org.id === activeOrgId) ?? organizations[0];
  const displayName = activeOrg?.name ?? "Workspace";

  return (
    <>
      {/* Fixed 248px rail. Below `lg` the shell renders the drawer instead. */}
      <aside className="hidden w-62 shrink-0 flex-col border-r border-border bg-panel-quiet lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Image
            src="/logo.svg"
            alt=""
            width={26}
            height={26}
            className="size-6.5 shrink-0"
            priority
          />
          <span className="text-[15px] font-extrabold tracking-[-0.02em] text-foreground">
            ClipMux
          </span>
        </div>

        {/* Organization switcher */}
        <div className="px-3">
          <button
            type="button"
            onClick={() => setIsOrgSwitcherOpen((open) => !open)}
            aria-expanded={isOrgSwitcherOpen}
            aria-controls="organization-switcher-panel"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl border border-border bg-panel px-2.5 py-2.5 text-left transition-colors",
              "hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <OrgMark name={displayName} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {displayName}
              </span>
              <span className="block text-[13px] text-muted-foreground">
                Organization
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                isOrgSwitcherOpen && "rotate-180",
              )}
            />
          </button>

          <div
            id="organization-switcher-panel"
            hidden={!isOrgSwitcherOpen}
            className="mt-2 overflow-hidden rounded-xl border border-border bg-panel"
          >
            <ul className="max-h-64 overflow-y-auto p-1.5">
              {organizations.map((org) => {
                const isActive = org.id === (activeOrg?.id ?? activeOrgId);
                return (
                  <li key={org.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOrgChange?.(org.id);
                        setIsOrgSwitcherOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-panel-strong text-foreground"
                          : "text-muted-foreground hover:bg-panel-strong/60 hover:text-foreground",
                      )}
                    >
                      <OrgMark name={org.name} className="size-7 text-[12px]" />
                      <span className="min-w-0 flex-1 truncate">{org.name}</span>
                      {isActive ? (
                        <Check className="size-4 shrink-0 text-ember" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-border-soft p-1.5">
              <button
                type="button"
                onClick={() => {
                  setIsCreateOrgOpen(true);
                  setIsOrgSwitcherOpen(false);
                }}
                className="w-full rounded-lg px-2.5 py-2.5 text-left text-sm font-semibold text-muted-foreground transition-colors hover:bg-panel-strong/60 hover:text-foreground"
              >
                Create organization
              </button>
            </div>
          </div>
        </div>

        {/* Upload */}
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={onUploadClick}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-brand text-sm font-semibold text-brand-foreground transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel-quiet"
          >
            <Upload className="size-4" />
            Upload video
          </button>
        </div>

        <nav
          aria-label="Dashboard"
          className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4"
        >
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-panel-strong text-foreground"
                    : "text-muted-foreground hover:bg-panel-strong/60 hover:text-foreground",
                )}
              >
                <Icon
                  className={cn(
                    "size-4.5 shrink-0",
                    isActive ? "text-ember" : "text-faint-foreground",
                  )}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border px-5 py-4">
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="dash-dot status-ready" aria-hidden="true" />
            Platform reachable
          </p>
        </div>
      </aside>

      <CreateOrganizationModal
        open={isCreateOrgOpen}
        onClose={() => setIsCreateOrgOpen(false)}
      />
    </>
  );
}

/**
 * The same navigation, rendered inside the mobile drawer. Kept as a separate
 * export so the shell can mount it inside a focus-trapping sheet without
 * duplicating the desktop rail in the layout tree.
 */
export function DashboardMobileNav({
  organizations = [],
  activeOrgId,
  onOrgChange,
  onUploadClick,
  onNavigate,
}: Omit<DashboardSidebarProps, "userName"> & {
  /** Called after any action that should dismiss the drawer. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [isCreateOrgOpen, setIsCreateOrgOpen] = React.useState(false);

  const activeOrg =
    organizations.find((org) => org.id === activeOrgId) ?? organizations[0];
  const displayName = activeOrg?.name ?? "Workspace";

  return (
    <div className="flex h-full flex-col bg-panel-quiet">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <Image
          src="/logo.svg"
          alt=""
          width={26}
          height={26}
          className="size-6.5 shrink-0"
        />
        <span className="text-[15px] font-extrabold tracking-[-0.02em]">ClipMux</span>
      </div>

      <div className="px-4">
        <p className="dash-label">Organization</p>
        <ul className="mt-2 space-y-1">
          {organizations.map((org) => {
            const isActive = org.id === (activeOrg?.id ?? activeOrgId);
            return (
              <li key={org.id}>
                <button
                  type="button"
                  onClick={() => onOrgChange?.(org.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                    isActive
                      ? "border-border bg-panel text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-panel-strong/60",
                  )}
                >
                  <OrgMark name={org.name} className="size-7 text-[12px]" />
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                  {isActive ? <Check className="size-4 text-ember" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => setIsCreateOrgOpen(true)}
          className="mt-2 w-full rounded-lg border border-border px-3 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          Create organization
        </button>
      </div>

      <div className="px-4 pt-4">
        <button
          type="button"
          onClick={() => {
            onUploadClick?.();
            onNavigate?.();
          }}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-brand text-sm font-semibold text-brand-foreground transition-colors hover:bg-brand-hover"
        >
          <Upload className="size-4" />
          Upload video
        </button>
      </div>

      <nav
        aria-label="Dashboard"
        className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3 pb-6"
      >
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-3 text-[15px] font-medium transition-colors",
                isActive
                  ? "bg-panel-strong text-foreground"
                  : "text-muted-foreground hover:bg-panel-strong/60 hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "size-4.5 shrink-0",
                  isActive ? "text-ember" : "text-faint-foreground",
                )}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <CreateOrganizationModal
        open={isCreateOrgOpen}
        onClose={() => setIsCreateOrgOpen(false)}
      />
    </div>
  );
}
