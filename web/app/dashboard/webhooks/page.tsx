'use client'

import * as React from 'react'
import {
  Loader2,
  Webhook,
  Plus,
  Copy,
  Check,
  Trash2,
  MoreVertical,
  Eye,
  EyeOff,
  Info,
  AlertTriangle,
} from 'lucide-react'
import { useSession, useActiveOrganization } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4080'

interface WebhookEndpoint {
  id: string
  url: string
  events: string[] | null
  enabled: boolean
  description: string | null
  lastTriggeredAt: string | null
  createdAt: string
}

interface NewWebhookResponse {
  id: string
  url: string
  secret: string
  events: string[]
  message: string
}

export default function WebhooksPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { data: activeOrg, isPending: orgPending } = useActiveOrganization()

  const [webhooks, setWebhooks] = React.useState<WebhookEndpoint[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Create modal
  const [showCreateModal, setShowCreateModal] = React.useState(false)
  const [newUrl, setNewUrl] = React.useState('')
  const [isCreating, setIsCreating] = React.useState(false)

  // Newly created webhook (shown once with secret)
  const [newlyCreated, setNewlyCreated] =
    React.useState<NewWebhookResponse | null>(null)
  const [secretCopied, setSecretCopied] = React.useState(false)
  const [secretVisible, setSecretVisible] = React.useState(false)

  // Delete confirmation
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)

  // Toggle enabled
  const [togglingId, setTogglingId] = React.useState<string | null>(null)

  // Fetch webhooks
  const fetchWebhooks = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/webhooks`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to fetch webhooks')
      const data = await res.json()
      setWebhooks(data.endpoints || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhooks')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (session && activeOrg) {
      fetchWebhooks()
    }
  }, [session, activeOrg, fetchWebhooks])

  // Create new webhook
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUrl.trim()) return

    setIsCreating(true)
    setError(null)

    try {
      const res = await fetch(`${API_URL}/webhooks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newUrl.trim(),
          events: [
            'video.uploading',
            'video.uploaded',
            'video.ready',
            'video.failed',
            'video.updated',
            'video.deleted',
            'subtitle.generated',
            'chapters.generated',
          ],
        }),
      })

      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Failed to create webhook')
      }

      const data: NewWebhookResponse = await res.json()
      setNewlyCreated(data)
      setShowCreateModal(false)
      setNewUrl('')
      fetchWebhooks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook')
    } finally {
      setIsCreating(false)
    }
  }

  // Copy secret
  const handleCopySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret)
    setSecretCopied(true)
    setTimeout(() => setSecretCopied(false), 2000)
  }

  // Toggle enabled
  const handleToggle = async (id: string, currentEnabled: boolean) => {
    setTogglingId(id)
    try {
      const res = await fetch(`${API_URL}/webhooks/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentEnabled }),
      })
      if (!res.ok) throw new Error('Failed to update webhook')
      fetchWebhooks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle webhook')
    } finally {
      setTogglingId(null)
    }
  }

  // Delete webhook
  const handleDelete = async () => {
    if (!deleteId) return

    setIsDeleting(true)
    try {
      const res = await fetch(`${API_URL}/api/webhooks/${deleteId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to delete webhook')
      setDeleteId(null)
      fetchWebhooks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete webhook')
    } finally {
      setIsDeleting(false)
    }
  }

  // Format date
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never'
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  // Loading state
  if (sessionPending || orgPending || loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )
  }

  if (!session || !activeOrg) {
    return null
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-foreground">Webhooks</h1>
          <button className="p-1 rounded-full hover:bg-muted/50 transition-colors">
            <Info className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>Create webhook</Button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Newly Created Webhook Banner */}
      {newlyCreated && (
        <div className="p-5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
              <Webhook className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-foreground mb-1">
                Webhook Created
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                Save your signing secret now. You won't be able to see it again!
              </p>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-background/50 border border-border font-mono text-sm">
                <code className="flex-1 break-all text-foreground">
                  {secretVisible ? newlyCreated.secret : '•'.repeat(40)}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSecretVisible(!secretVisible)}
                >
                  {secretVisible ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleCopySecret(newlyCreated.secret)}
                >
                  {secretCopied ? (
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
              onClick={() => setNewlyCreated(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Webhooks Table */}
      <div className="glass rounded-2xl overflow-hidden">
        {webhooks.length === 0 ? (
          <div className="p-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
              <Webhook className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">
              No Webhooks
            </h3>
            <p className="text-muted-foreground mb-4">
              Create your first webhook to receive event notifications
            </p>
            <Button onClick={() => setShowCreateModal(true)}>
              <Plus className="w-4 h-4" />
              Create webhook
            </Button>
          </div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-border">
              <tr className="text-left text-sm text-muted-foreground">
                <th className="px-6 py-4 font-medium w-20"></th>
                <th className="px-6 py-4 font-medium">Endpoint</th>
                <th className="px-6 py-4 font-medium">Created</th>
                <th className="px-6 py-4 font-medium w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {webhooks.map((wh) => (
                <tr key={wh.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-6 py-4">
                    {/* Toggle Switch */}
                    <button
                      onClick={() => handleToggle(wh.id, wh.enabled)}
                      disabled={togglingId === wh.id}
                      className={cn(
                        'relative w-12 h-6 rounded-full transition-colors',
                        wh.enabled ? 'bg-primary' : 'bg-muted-foreground/30',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform',
                          wh.enabled && 'translate-x-6',
                        )}
                      />
                    </button>
                  </td>
                  <td className="px-6 py-4">
                    <a
                      href={wh.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline font-mono text-sm"
                    >
                      {wh.url}
                    </a>
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {formatDate(wh.createdAt)}
                  </td>
                  <td className="px-6 py-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setDeleteId(wh.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
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

      {/* Create Webhook Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="glass rounded-2xl p-6 w-full max-w-md mx-4">
            <h2 className="text-xl font-bold text-foreground mb-4">
              Create Webhook
            </h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="webhookUrl">Endpoint URL</Label>
                <Input
                  id="webhookUrl"
                  type="url"
                  placeholder="https://your-server.com/webhook"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Must use HTTPS for production webhooks
                </p>
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
                  disabled={isCreating || !newUrl.trim()}
                  className="flex-1"
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create'
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="glass rounded-2xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-destructive/20 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-destructive" />
              </div>
              <h2 className="text-xl font-bold text-foreground">
                Delete Webhook
              </h2>
            </div>
            <p className="text-muted-foreground mb-6">
              Are you sure you want to delete this webhook? You will stop
              receiving events at this endpoint.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => setDeleteId(null)}
                className="flex-1"
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1 bg-destructive hover:bg-destructive/90"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
