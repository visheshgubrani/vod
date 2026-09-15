"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Settings, ChevronRight, Menu } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth-client";

interface DashboardHeaderProps {
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  organizationName?: string;
  onOpenNav?: () => void;
}

const PAGE_LABELS: Array<[prefix: string, label: string]> = [
  ["/dashboard/analytics", "Analytics"],
  ["/dashboard/api-keys", "API keys"],
  ["/dashboard/webhooks", "Webhooks"],
  ["/dashboard/transcoders", "Transcoders"],
  ["/dashboard/usage", "Usage"],
  ["/dashboard/settings", "Settings"],
  ["/dashboard/videos", "Video"],
];

export function DashboardHeader({
  userName = "User",
  userEmail = "",
  userImage,
  organizationName = "Organization",
  onOpenNav,
}: DashboardHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isSigningOut, setIsSigningOut] = React.useState(false);

  const currentPageLabel = React.useMemo(() => {
    const match = PAGE_LABELS.find(([prefix]) => pathname.startsWith(prefix));
    return match?.[1] ?? "Library";
  }, [pathname]);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await signOut();
      router.push("/login");
    } catch (error) {
      console.error("Sign out error:", error);
      setIsSigningOut(false);
    }
  };

  return (
    <header className="relative z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background px-4 md:px-8">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="-ml-1 inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-strong hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex items-center gap-1.5 text-sm">
          <li className="hidden truncate text-muted-foreground sm:block">
            {organizationName}
          </li>
          <li className="hidden sm:block" aria-hidden="true">
            <ChevronRight className="size-4 text-faint-foreground" />
          </li>
          <li className="truncate font-semibold text-foreground">
            {currentPageLabel}
          </li>
        </ol>
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="inline-flex size-11 items-center justify-center rounded-full transition-colors hover:bg-panel-strong"
          >
            <Avatar src={userImage} fallback={userName} className="size-8" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="z-[80] w-60 rounded-xl border border-border bg-popover p-1.5"
        >
          <DropdownMenuLabel>
            <span className="flex flex-col gap-0.5 pb-1">
              <span className="truncate text-sm font-semibold text-foreground">
                {userName}
              </span>
              <span className="truncate text-[13px] font-normal text-muted-foreground">
                {userEmail}
              </span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
            <Settings className="size-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSignOut}
            disabled={isSigningOut}
            destructive
          >
            <LogOut className="size-4" />
            {isSigningOut ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
