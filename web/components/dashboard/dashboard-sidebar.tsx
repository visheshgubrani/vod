"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    LayoutDashboard,
    Film,
    BarChart3,
    Code2,
    Settings,
    ChevronDown,
    Plus,
    Building2,
    User,
    Check,
    Key,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

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
    { href: "/dashboard/content", label: "Content", icon: Film },
    { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
    { href: "/dashboard/api-keys", label: "API Keys", icon: Key },
    { href: "/dashboard/developers", label: "Developers", icon: Code2 },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardSidebar({
    userName = "User",
    organizations = [],
    activeOrgId,
    onOrgChange,
    onUploadClick,
}: DashboardSidebarProps) {
    const pathname = usePathname();

    const activeOrg = organizations.find((org) => org.id === activeOrgId);
    const displayName = activeOrg?.name ?? "Personal";

    return (
        <aside className="flex flex-col w-64 h-screen bg-card/50 border-r border-border backdrop-blur-sm">
            {/* Organization Switcher */}
            <div className="p-4 border-b border-border">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-3 w-full p-2 rounded-lg hover:bg-muted/50 transition-colors group">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-md">
                                {activeOrg ? (
                                    <Building2 className="w-4 h-4 text-white" />
                                ) : (
                                    <User className="w-4 h-4 text-white" />
                                )}
                            </div>
                            <div className="flex-1 text-left">
                                <p className="text-sm font-medium text-foreground truncate">
                                    {displayName}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {activeOrg ? "Organization" : "Personal Account"}
                                </p>
                            </div>
                            <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                        <DropdownMenuLabel>Switch Account</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onOrgChange?.(null)}>
                            <User className="w-4 h-4" />
                            <span className="flex-1">Personal</span>
                            {!activeOrgId && <Check className="w-4 h-4 text-primary" />}
                        </DropdownMenuItem>
                        {organizations.map((org) => (
                            <DropdownMenuItem
                                key={org.id}
                                onClick={() => onOrgChange?.(org.id)}
                            >
                                <Building2 className="w-4 h-4" />
                                <span className="flex-1 truncate">{org.name}</span>
                                {activeOrgId === org.id && (
                                    <Check className="w-4 h-4 text-primary" />
                                )}
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem>
                            <Plus className="w-4 h-4" />
                            Create Organization
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Upload Button */}
            <div className="p-4">
                <button
                    onClick={onUploadClick}
                    className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-primary to-accent text-white font-semibold shadow-lg hover:opacity-90 hover:scale-[1.02] transition-all duration-200"
                >
                    <Plus className="w-5 h-5" />
                    Upload Video
                </button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
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
                                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                                isActive
                                    ? "bg-primary/10 text-primary border border-primary/20"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                            )}
                        >
                            <Icon className="w-5 h-5" />
                            {item.label}
                        </Link>
                    );
                })}
            </nav>

            {/* Footer */}
            <div className="p-4 border-t border-border">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    All systems operational
                </div>
            </div>
        </aside>
    );
}
