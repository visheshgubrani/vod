"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
    breadcrumb?: { label: string; href?: string }[];
}

export function DashboardHeader({
    userName = "User",
    userEmail = "",
    userImage,
    breadcrumb = [{ label: "Dashboard" }, { label: "Overview" }],
}: DashboardHeaderProps) {
    const router = useRouter();
    const [isSigningOut, setIsSigningOut] = React.useState(false);

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
        <header className="flex items-center justify-between h-16 px-6 border-b border-border bg-card/30 backdrop-blur-sm">
            {/* Breadcrumb */}
            <nav className="flex items-center gap-1 text-sm">
                {breadcrumb.map((item, index) => (
                    <React.Fragment key={index}>
                        {index > 0 && (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        )}
                        <span
                            className={
                                index === breadcrumb.length - 1
                                    ? "text-foreground font-medium"
                                    : "text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                            }
                        >
                            {item.label}
                        </span>
                    </React.Fragment>
                ))}
            </nav>

            {/* User Menu */}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-3 p-1.5 rounded-full hover:bg-muted/50 transition-colors">
                        <Avatar
                            src={userImage}
                            fallback={userName}
                            size="sm"
                        />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>
                        <div className="flex flex-col">
                            <span className="font-medium">{userName}</span>
                            <span className="text-xs font-normal text-muted-foreground truncate">
                                {userEmail}
                            </span>
                        </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
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
