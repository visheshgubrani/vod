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
} from "lucide-react";
import { IoAddCircleOutline } from "react-icons/io5";
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
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  // { href: "/dashboard/content", label: "Content", icon: Film },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/api-keys", label: "API Keys", icon: Key },
  { href: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/dashboard/usage", label: "Usage", icon: HardDrive },
  // { href: "/dashboard/developers", label: "Developers", icon: Code2 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

interface SidebarIconButtonProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
  iconClassName?: string;
}

function SidebarIconButton({
  label,
  icon: Icon,
  href,
  isActive = false,
  onClick,
  className,
  iconClassName,
}: SidebarIconButtonProps) {
  const buttonClassName = cn(
    "flex size-11 items-center justify-center rounded-sm border transition-all duration-200",
    isActive
      ? "border-primary/30 bg-primary/15 text-foreground"
      : "border-transparent text-muted-foreground/85 hover:border-border hover:bg-accent/10 hover:text-foreground",
    className
  );

  if (href) {
    return (
      <Link
        href={href}
        className={buttonClassName}
        aria-label={label}
        title={label}
      >
        <Icon className={cn("size-5", iconClassName)} />
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={buttonClassName}
      aria-label={label}
      title={label}
    >
      <Icon className={cn("size-5", iconClassName)} />
    </button>
  );
}

export function DashboardSidebar({
  userName = "User",
  organizations = [],
  activeOrgId,
  onOrgChange,
  onUploadClick,
}: DashboardSidebarProps) {
  const pathname = usePathname();
  const [isOrgSwitcherOpen, setIsOrgSwitcherOpen] = React.useState(false);
  const [isCreateOrgOpen, setIsCreateOrgOpen] = React.useState(false);
  const [isCompactOrgOpen, setIsCompactOrgOpen] = React.useState(false);

  const activeOrg =
    organizations.find((org) => org.id === activeOrgId) ?? organizations[0];
  const displayName = activeOrg?.name ?? "Workspace";

  return (
    <>
      <aside className="flex h-screen w-18 flex-col border-r border-border bg-card/50 backdrop-blur-sm lg:w-66">
        <div className="lg:hidden border-b border-muted px-3 py-3">
          <div className="relative flex flex-col items-center gap-3 pt-1">
            <SidebarIconButton
              label={displayName}
              icon={() => (
                <Image
                  src="/logo.svg"
                  alt="ClipMux logo"
                  width={24}
                  height={24}
                  className="size-8 w-auto shrink-0"
                  priority
                />
              )}
              onClick={() => setIsCompactOrgOpen((open) => !open)}
              className="border-transparent bg-transparent text-white shadow-none hover:border-transparent hover:bg-transparent hover:text-white"
            />
            <SidebarIconButton
              label="Upload Video"
              icon={IoAddCircleOutline}
              onClick={onUploadClick}
            />

            {isCompactOrgOpen ? (
              <div className="absolute left-full top-0 z-20 ml-3 w-60 rounded-sm border border-border bg-card p-2 shadow-2xl">
                <div className="border-b border-muted-foreground/15 px-2 pb-2">
                  <p className="truncate text-sm font-medium text-foreground">
                    {displayName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Current organization
                  </p>
                </div>

                <div className="space-y-1 pt-2">
                  {organizations.map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => {
                        onOrgChange?.(org.id);
                        setIsCompactOrgOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-sm px-3 py-3 text-sm font-medium transition-all duration-200",
                        activeOrgId === org.id
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground/85 hover:bg-accent/10 hover:text-foreground"
                      )}
                    >
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full bg-foreground/30",
                          activeOrgId === org.id && "bg-lime-600"
                        )}
                      />
                      <span className="flex-1 truncate text-left">
                        {org.name}
                      </span>
                    </button>
                  ))}

                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateOrgOpen(true);
                      setIsCompactOrgOpen(false);
                    }}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-sm border border-foreground/10 bg-black/20 px-4 py-2.5 font-semibold text-white shadow-lg transition-all duration-200 hover:opacity-90"
                  >
                    <IoAddCircleOutline className="size-5" />
                    Create Organization
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="hidden lg:block">
          {/* Organization Switcher */}
          <div className="border-b w-full border-muted">
            <div className="bg-muted/55 p-2">
              <button
                type="button"
                onClick={() => setIsOrgSwitcherOpen((open) => !open)}
                className="flex items-center gap-1 w-full rounded-sm px-1 py-2 text-left transition-colors group"
                aria-expanded={isOrgSwitcherOpen}
                aria-controls="organization-switcher-panel"
              >
                <div className="flex items-center justify-center shrink-0">
                  <Image
                    src="/logo.svg"
                    alt="ClipMux logo"
                    width={34}
                    height={34}
                    className="size-10 w-auto shrink-0"
                    priority
                  />
                </div>
                <div className="ml-1 min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">
                    {displayName}
                  </p>
                  <p className="text-xs text-muted-foreground/80">
                    Current organization
                  </p>
                </div>
                <ChevronDown
                  className={cn(
                    "size-4.5 ml-auto shrink-0 text-muted-foreground group-hover:text-foreground transition-all duration-200",
                    isOrgSwitcherOpen && "rotate-180"
                  )}
                />
              </button>

              <div
                id="organization-switcher-panel"
                className={cn(
                  "grid transition-all duration-200 ease-out",
                  isOrgSwitcherOpen
                    ? "grid-rows-[1fr] opacity-100 pt-2"
                    : "grid-rows-[0fr] opacity-0"
                )}
              >
                <div className="overflow-hidden">
                  <div className="space-y-1 border-t border-muted-foreground/15 pt-2">
                    {organizations.map((org) => (
                      <button
                        key={org.id}
                        type="button"
                        onClick={() => onOrgChange?.(org.id)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-sm px-3 py-3 text-sm font-medium transition-all duration-200",
                          activeOrgId === org.id
                            ? "bg-secondary"
                            : "text-muted-foreground/85 hover:text-foreground hover:bg-accent/10"
                        )}
                      >
                        <span
                          className={cn(
                            "size-2.5 shrink-0 rounded-full bg-foreground/30",
                            activeOrgId === org.id && "bg-lime-600"
                          )}
                        />
                        <span className="flex-1 truncate text-left">
                          {org.name}
                        </span>
                      </button>
                    ))}

                    <button
                      type="button"
                      onClick={() => setIsCreateOrgOpen(true)}
                      className="mb-2 mt-4 flex items-center border border-foreground/10 justify-center gap-2 w-full py-2.5 px-4 rounded-sm bg-black/20 text-white font-semibold shadow-lg hover:opacity-90 transition-all duration-200"
                    >
                      <IoAddCircleOutline className="w-5 h-5" />
                      Create Organization
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Upload Button */}
        <div className="mt-3 hidden p-3 lg:block">
          <button
            onClick={onUploadClick}
            className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-sm bg-gradient-to-r from-primary to-accent text-white font-semibold shadow-lg hover:opacity-90 transition-all duration-200"
          >
            <IoAddCircleOutline className="w-5 h-5" />
            Upload Video
          </button>
        </div>

        {/* Navigation */}
        <nav className="hidden flex-1 space-y-2 overflow-y-auto px-3 py-2 lg:block">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-3 rounded-sm text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary/15 text-foreground border border-primary/35"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/10"
                )}
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <nav className="flex flex-1 flex-col items-center gap-2 px-3 py-4 lg:hidden">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));

            return (
              <SidebarIconButton
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                isActive={isActive}
              />
            );
          })}
        </nav>

        {/* Footer */}
        <div className="hidden border-t border-border p-4 lg:block">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            All systems operational
          </div>
        </div>
        <div className="border-t overflow-hidden border-border px-3 py-4 lg:hidden">
          <div className="mx-auto size-3 rounded-full bg-emerald-500 animate-pulse" />
        </div>
      </aside>

      <CreateOrganizationModal
        open={isCreateOrgOpen}
        onClose={() => setIsCreateOrgOpen(false)}
      />
    </>
  );
}
