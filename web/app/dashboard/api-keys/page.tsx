"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
    Loader2,
    Key,
    Plus,
    Copy,
    Check,
    Trash2,
    RefreshCw,
    Eye,
    EyeOff,
    MoreVertical,
    AlertTriangle,
} from "lucide-react";
import { useSession, useActiveOrganization } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080";

interface ApiKey {
    id: string;
    name: string;
    label?: string | null;
    key_preview: string;
    last_used_at: string | null;
    created_at: string;
}

interface NewKeyResponse {
    id: string;
    name: string;
    key: string;
    key_preview: string;
    message: string;
}

export default function ApiKeysPage() {
    const router = useRouter();
    const { data: session, isPending: sessionPending } = useSession();
    const { data: activeOrg, isPending: orgPending } = useActiveOrganization();

    const [keys, setKeys] = React.useState<ApiKey[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    
    // Create key modal
    const [showCreateModal, setShowCreateModal] = React.useState(false);
    const [newKeyName, setNewKeyName] = React.useState("");
    const [newKeyLabel, setNewKeyLabel] = React.useState("");
    const [isCreating, setIsCreating] = React.useState(false);
    
    // Newly created key (shown once)
    const [newlyCreatedKey, setNewlyCreatedKey] = React.useState<NewKeyResponse | null>(null);
    const [keyCopied, setKeyCopied] = React.useState(false);
    
    // Delete confirmation
    const [deleteKeyId, setDeleteKeyId] = React.useState<string | null>(null);
    const [isDeleting, setIsDeleting] = React.useState(false);
    
    // Regenerate confirmation
    const [regenerateKeyId, setRegenerateKeyId] = React.useState<string | null>(null);
    const [isRegenerating, setIsRegenerating] = React.useState(false);

    // Fetch API keys
    const fetchKeys = React.useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/keys`, {
                credentials: "include",
            });
            if (!res.ok) throw new Error("Failed to fetch API keys");
            const data = await res.json();
            setKeys(data.keys || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load API keys");
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        if (session && activeOrg) {
            fetchKeys();
        }
    }, [session, activeOrg, fetchKeys]);

    // Create new key
    const handleCreateKey = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newKeyName.trim()) return;

        setIsCreating(true);
        setError(null);

        try {
            const res = await fetch(`${API_URL}/api/keys`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: newKeyName.trim(),
                    label: newKeyLabel.trim() || undefined,
                }),
            });

            if (!res.ok) throw new Error("Failed to create API key");

            const data: NewKeyResponse = await res.json();
            setNewlyCreatedKey(data);
            setShowCreateModal(false);
            setNewKeyName("");
            setNewKeyLabel("");
            fetchKeys();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create API key");
        } finally {
            setIsCreating(false);
        }
    };

    // Copy key to clipboard
    const handleCopyKey = async (key: string) => {
        await navigator.clipboard.writeText(key);
        setKeyCopied(true);
        setTimeout(() => setKeyCopied(false), 2000);
    };

    // Delete key
    const handleDeleteKey = async () => {
        if (!deleteKeyId) return;

        setIsDeleting(true);
        try {
            const res = await fetch(`${API_URL}/api/keys/${deleteKeyId}`, {
                method: "DELETE",
                credentials: "include",
            });

            if (!res.ok) throw new Error("Failed to delete API key");

            setDeleteKeyId(null);
            fetchKeys();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to delete API key");
        } finally {
            setIsDeleting(false);
        }
    };

    // Regenerate key
    const handleRegenerateKey = async () => {
        if (!regenerateKeyId) return;

        setIsRegenerating(true);
        try {
            const res = await fetch(`${API_URL}/api/keys/${regenerateKeyId}/regenerate`, {
                method: "POST",
                credentials: "include",
            });

            if (!res.ok) throw new Error("Failed to regenerate API key");

            const data: NewKeyResponse = await res.json();
            setNewlyCreatedKey(data);
            setRegenerateKeyId(null);
            fetchKeys();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to regenerate API key");
        } finally {
            setIsRegenerating(false);
        }
    };

    // Format date
    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return "Never";
        return new Date(dateStr).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    };

    // Loading state
    if (sessionPending || orgPending || loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
        );
    }

    if (!session || !activeOrg) {
        return null;
    }

    return (
        <div className="max-w-4xl space-y-6">
            {/* Page Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">API Keys</h1>
                    <p className="text-muted-foreground mt-1">
                        Manage your API keys for programmatic access
                    </p>
                </div>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="w-4 h-4" />
                    Create Key
                </Button>
            </div>

            {/* Error Banner */}
            {error && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                    {error}
                </div>
            )}

            {/* Newly Created Key Banner */}
            {newlyCreatedKey && (
                <div className="p-5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30">
                    <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                            <Key className="w-5 h-5 text-emerald-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="text-lg font-semibold text-foreground mb-1">
                                API Key Created
                            </h3>
                            <p className="text-sm text-muted-foreground mb-4">
                                Make sure to copy your API key now. You won't be able to see it again!
                            </p>
                            <div className="flex items-center gap-2 p-3 rounded-lg bg-background/50 border border-border font-mono text-sm">
                                <code className="flex-1 break-all text-foreground">
                                    {newlyCreatedKey.key}
                                </code>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleCopyKey(newlyCreatedKey.key)}
                                    className="flex-shrink-0"
                                >
                                    {keyCopied ? (
                                        <Check className="w-4 h-4 text-emerald-400" />
                                    ) : (
                                        <Copy className="w-4 h-4" />
                                    )}
                                </Button>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setNewlyCreatedKey(null)}
                            className="flex-shrink-0"
                        >
                            Dismiss
                        </Button>
                    </div>
                </div>
            )}

            {/* API Keys Table */}
            <div className="glass rounded-2xl overflow-hidden">
                {keys.length === 0 ? (
                    <div className="p-12 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                            <Key className="w-8 h-8 text-muted-foreground" />
                        </div>
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                            No API Keys
                        </h3>
                        <p className="text-muted-foreground mb-4">
                            Create your first API key to start integrating
                        </p>
                        <Button onClick={() => setShowCreateModal(true)}>
                            <Plus className="w-4 h-4" />
                            Create Key
                        </Button>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead className="border-b border-border">
                            <tr className="text-left text-sm text-muted-foreground">
                                <th className="px-6 py-4 font-medium">Name</th>
                                <th className="px-6 py-4 font-medium">Key</th>
                                <th className="px-6 py-4 font-medium">Last Used</th>
                                <th className="px-6 py-4 font-medium">Created</th>
                                <th className="px-6 py-4 font-medium w-12"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {keys.map((key) => (
                                <tr key={key.id} className="hover:bg-muted/30 transition-colors">
                                    <td className="px-6 py-4">
                                        <div>
                                            <p className="font-medium text-foreground">{key.name}</p>
                                            {key.label && (
                                                <p className="text-xs text-muted-foreground">{key.label}</p>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <code className="text-sm text-muted-foreground font-mono bg-muted/50 px-2 py-1 rounded">
                                            {key.key_preview}
                                        </code>
                                    </td>
                                    <td className="px-6 py-4 text-sm text-muted-foreground">
                                        {formatDate(key.last_used_at)}
                                    </td>
                                    <td className="px-6 py-4 text-sm text-muted-foreground">
                                        {formatDate(key.created_at)}
                                    </td>
                                    <td className="px-6 py-4">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button size="sm" variant="ghost">
                                                    <MoreVertical className="w-4 h-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem onClick={() => setRegenerateKeyId(key.id)}>
                                                    <RefreshCw className="w-4 h-4" />
                                                    Regenerate
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    onClick={() => setDeleteKeyId(key.id)}
                                                    className="text-destructive focus:text-destructive"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                    Revoke
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Usage Information */}
            <div className="glass rounded-2xl p-6">
                <h3 className="text-lg font-semibold text-foreground mb-3">Using Your API Key</h3>
                <p className="text-muted-foreground text-sm mb-4">
                    Include your API key in the Authorization header of your requests:
                </p>
                <div className="p-4 rounded-xl bg-muted/30 border border-border font-mono text-sm overflow-x-auto">
                    <code className="text-foreground">
                        curl -H "Authorization: Bearer sk_live_xxxxx" \<br />
                        &nbsp;&nbsp;{API_URL}/v1/videos
                    </code>
                </div>
            </div>

            {/* Create Key Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="glass rounded-2xl p-6 w-full max-w-md mx-4">
                        <h2 className="text-xl font-bold text-foreground mb-4">Create API Key</h2>
                        <form onSubmit={handleCreateKey} className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="keyName">Name</Label>
                                <Input
                                    id="keyName"
                                    placeholder="Production Key"
                                    value={newKeyName}
                                    onChange={(e) => setNewKeyName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="keyLabel">Label (optional)</Label>
                                <Input
                                    id="keyLabel"
                                    placeholder="Used for..."
                                    value={newKeyLabel}
                                    onChange={(e) => setNewKeyLabel(e.target.value)}
                                />
                            </div>
                            <div className="flex gap-3 pt-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setShowCreateModal(false)}
                                    className="flex-1"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={isCreating || !newKeyName.trim()}
                                    className="flex-1"
                                >
                                    {isCreating ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Creating...
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="w-4 h-4" />
                                            Create
                                        </>
                                    )}
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteKeyId && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="glass rounded-2xl p-6 w-full max-w-md mx-4">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-destructive/20 flex items-center justify-center">
                                <AlertTriangle className="w-5 h-5 text-destructive" />
                            </div>
                            <h2 className="text-xl font-bold text-foreground">Revoke API Key</h2>
                        </div>
                        <p className="text-muted-foreground mb-6">
                            Are you sure you want to revoke this API key? Any applications using this key will immediately lose access.
                        </p>
                        <div className="flex gap-3">
                            <Button
                                variant="outline"
                                onClick={() => setDeleteKeyId(null)}
                                className="flex-1"
                                disabled={isDeleting}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleDeleteKey}
                                disabled={isDeleting}
                                className="flex-1 bg-destructive hover:bg-destructive/90"
                            >
                                {isDeleting ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Revoking...
                                    </>
                                ) : (
                                    <>
                                        <Trash2 className="w-4 h-4" />
                                        Revoke Key
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Regenerate Confirmation Modal */}
            {regenerateKeyId && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="glass rounded-2xl p-6 w-full max-w-md mx-4">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                                <RefreshCw className="w-5 h-5 text-amber-400" />
                            </div>
                            <h2 className="text-xl font-bold text-foreground">Regenerate API Key</h2>
                        </div>
                        <p className="text-muted-foreground mb-6">
                            This will generate a new key and invalidate the current one. Any applications using the old key will need to be updated.
                        </p>
                        <div className="flex gap-3">
                            <Button
                                variant="outline"
                                onClick={() => setRegenerateKeyId(null)}
                                className="flex-1"
                                disabled={isRegenerating}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleRegenerateKey}
                                disabled={isRegenerating}
                                className="flex-1"
                            >
                                {isRegenerating ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Regenerating...
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw className="w-4 h-4" />
                                        Regenerate
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
