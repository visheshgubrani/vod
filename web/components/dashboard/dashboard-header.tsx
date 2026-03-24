"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Settings, ChevronRight } from "lucide-react";
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
}

export function DashboardHeader({
  userName = "User",
  userEmail = "",
  userImage,
  organizationName = "Organization",
}: DashboardHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isSigningOut, setIsSigningOut] = React.useState(false);

  const currentPageLabel = React.useMemo(() => {
    if (pathname === "/dashboard") return "Dashboard";
    if (pathname.startsWith("/dashboard/analytics")) return "Analytics";
    if (pathname.startsWith("/dashboard/api-keys")) return "API Keys";
    if (pathname.startsWith("/dashboard/webhooks")) return "Webhooks";
    if (pathname.startsWith("/dashboard/usage")) return "Usage";
    if (pathname.startsWith("/dashboard/settings")) return "Settings";
    return "Dashboard";
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
    <header className="relative z-20 flex h-16 items-center justify-between border-b border-border bg-card/30 px-4 md:px-6 backdrop-blur-sm">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm">
        <span className="hidden text-muted-foreground sm:inline">
          {organizationName}
        </span>
        <ChevronRight className="hidden w-4 h-4 text-muted-foreground sm:inline" />
        <span className="font-medium text-foreground">{currentPageLabel}</span>
      </nav>

      {/* User Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center size-10 md:size-12  border-2 border-mauve-400/50 p-0.5 gap-3 rounded-full hover:bg-muted/50 transition-colors">
            <Avatar src={userImage} fallback={userName} className="size-[33px] md:size-[41px]"/>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[80] rounded-sm bg-muted divide-y divide-muted-foreground/10 w-56">
          <DropdownMenuLabel>
            <div className="flex flex-col pb-2">
              <span className="font-medium text-foreground/90">{userName}</span>
              <span className="text-xs font-normal text-muted-foreground truncate">
                {userEmail}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="hover:bg-muted-foreground/20" onClick={() => router.push("/dashboard/settings")}>
            <Settings className="w-4 h-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSignOut}
            disabled={isSigningOut}
            destructive
          >
            <LogOut className="w-4 h-4" />
            {isSigningOut ? "Signing out..." : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
