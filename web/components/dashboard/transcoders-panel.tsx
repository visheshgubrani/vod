"use client";

/**
 * Transcoders: pairing, agent health, folder browsing and local import.
 *
 * The single most important thing this component does is *not* confuse two
 * different filesystems. "Upload" reads the browser's machine; "Import from
 * transcoder" reads files on the agent's machine. The copy below says so
 * explicitly, in the empty state and above the browser, because a user who
 * assumes otherwise selects a file their agent cannot see and gets a confusing
 * failure.
 *
 * Absolute host paths never appear anywhere in this UI. The API does not return
 * them and the agent does not send them, so a browse result is always a
 * configured folder name plus a relative path — enough for an owner to recognise
 * their own file, and not enough to enumerate someone's disk.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Folder,
  HardDrive,
  Loader2,
  RefreshCw,
  ServerCog,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type AgentHealth,
  type DirectoryListing,
  type TranscoderJob,
  encoderLabel,
  formatBytes,
  pollControl,
  transcoderApi,
  waitingReasonLabel,
} from "@/lib/transcoder-api";
import { cn } from "@/lib/utils";

type SelectedFile = {
  agentId: string;
  rootName: string;
  relativePath: string;
  fileName: string;
  identity: string;
  sizeBytes: number;
};

export function TranscodersPanel() {
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [jobs, setJobs] = useState<TranscoderJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingCommand, setPairingCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Browser state
  const [browsingAgent, setBrowsingAgent] = useState<AgentHealth | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [policy, setPolicy] = useState<"public" | "signed">("public");
  const [subtitle, setSubtitle] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [agentReply, jobReply] = await Promise.all([
        transcoderApi.listAgents(),
        transcoderApi.jobs(50),
      ]);
      setAgents(agentReply.agents);
      setJobs(jobReply.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load transcoders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const onlineAgents = useMemo(() => agents.filter((agent) => agent.online), [agents]);

  // ── actions ──────────────────────────────────────────────────────────────

  async function pair() {
    setBusy("pair");
    try {
      const reply = await transcoderApi.createPairing();
      setPairingCode(reply.code);
      setPairingCommand(reply.command);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a pairing code");
    } finally {
      setBusy(null);
    }
  }

  async function openBrowser(agent: AgentHealth, path = ".", rootName?: string) {
    setBrowsingAgent(agent);
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const { controlId } = await transcoderApi.browse(agent.id, {
        path,
        rootName: rootName ?? listing?.root ?? undefined,
      });
      const result = await pollControl<DirectoryListing>(controlId);
      setListing(result);
    } catch (err) {
      // A timeout is reported as a timeout: "the machine did not answer" and
      // "that folder is empty" are different problems.
      setBrowseError(err instanceof Error ? err.message : "Could not read that folder");
      setListing(null);
    } finally {
      setBrowseLoading(false);
    }
  }

  function toggleFile(agent: AgentHealth, entry: { path: string; name: string; identity: string; size: number }) {
    setSelected((current) => {
      const exists = current.some((item) => item.identity === entry.identity);
      if (exists) return current.filter((item) => item.identity !== entry.identity);
      return [
        ...current,
        {
          agentId: agent.id,
          rootName: listing?.root ?? "",
          relativePath: entry.path,
          fileName: entry.name,
          identity: entry.identity,
          sizeBytes: entry.size,
        },
      ];
    });
  }

  async function runImport() {
    if (selected.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const items = [];
      for (const file of selected) {
        const source = await transcoderApi.registerSource(file);
        items.push({
          sourceRef: source.sourceRef,
          title: selected.length === 1 ? file.fileName.replace(/\.[^.]+$/, "") : undefined,
          playbackPolicy: policy,
          generateSubtitle: subtitle,
          // Stable per file: re-importing an unchanged file creates one video,
          // not two. The server enforces this with a unique index, so a
          // double-click or a retried request cannot produce a second encode.
          idempotencyKey: `dash:${file.identity}`,
        });
      }
      const reply = await transcoderApi.import(items);
      const created = reply.imports.filter((entry) => !entry.deduplicated);
      const deduped = reply.imports.length - created.length;
      setImported(
        deduped > 0
          ? `${created.length} queued, ${deduped} already imported`
          : `${created.length} queued for transcoding`,
      );
      setSelected([]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function cancelJob(jobId: string) {
    setBusy(jobId);
    try {
      await transcoderApi.cancelJob(jobId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel that job");
    } finally {
      setBusy(null);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading transcoders…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <Notice tone="error" icon={<AlertCircle className="h-4 w-4" />}>
          {error}
        </Notice>
      )}
      {imported && (
        <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
          {imported}
        </Notice>
      )}

      {/* ── machines ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Machines</h2>
            <p className="text-sm text-muted-foreground">
              A pair of your own computers can encode videos and import files that
              never leave your network. Files are read from the machine, not from
              this browser.
            </p>
          </div>
          <Button onClick={pair} disabled={busy === "pair"} size="sm">
            {busy === "pair" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
            Pair a machine
          </Button>
        </header>

        {pairingCode && (
          <div className="rounded-lg border bg-muted/40 p-4">
            <p className="text-sm font-medium">
              Pairing code — valid for 15 minutes, and only once
            </p>
            <div className="mt-2 flex items-center gap-3">
              <code className="rounded bg-background px-3 py-1.5 text-lg tracking-wider">
                {pairingCode}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(pairingCode)}
              >
                <Copy className="h-4 w-4" /> Copy
              </Button>
            </div>
            {pairingCommand && (
              <pre className="mt-3 overflow-x-auto rounded bg-background p-3 text-xs">
                {pairingCommand}
              </pre>
            )}
          </div>
        )}

        {agents.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="divide-y rounded-lg border">
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                busy={busy === agent.id}
                onBrowse={() => void openBrowser(agent)}
                onRevoke={async () => {
                  setBusy(agent.id);
                  try {
                    await transcoderApi.revokeAgent(agent.id);
                    await refresh();
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── browser ────────────────────────────────────────────────────── */}
      {browsingAgent && (
        <section className="space-y-3 rounded-lg border p-4">
          <header className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBrowsingAgent(null);
                  setListing(null);
                  setBrowseError(null);
                }}
              >
                <ArrowLeft className="h-4 w-4" /> Close
              </Button>
              <h2 className="text-lg font-semibold">
                Files on {browsingAgent.name}
              </h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openBrowser(browsingAgent, listing?.path ?? ".", listing?.root)}
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </header>

          {browseLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Asking the machine…
            </div>
          )}
          {browseError && (
            <Notice tone="error" icon={<AlertCircle className="h-4 w-4" />}>
              {browseError}
            </Notice>
          )}

          {listing && (
            <>
              <p className="text-sm text-muted-foreground">
                <Folder className="mr-1 inline h-3.5 w-3.5" />
                {listing.root ? `${listing.root}/` : ""}
                {listing.path === "." ? "" : listing.path}
              </p>
              <div className="divide-y rounded border">
                {listing.path !== "." && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
                    onClick={() =>
                      void openBrowser(
                        browsingAgent,
                        listing.path.split("/").slice(0, -1).join("/") || ".",
                        listing.root,
                      )
                    }
                  >
                    <Folder className="h-4 w-4 text-muted-foreground" /> ..
                  </button>
                )}
                {listing.entries.map((entry) => {
                  const isSelected = selected.some((item) => item.identity === entry.identity);
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-sm",
                        entry.isDirectory ? "hover:bg-muted/50" : "hover:bg-muted/50",
                        isSelected && "bg-muted",
                      )}
                      onClick={() =>
                        entry.isDirectory
                          ? void openBrowser(browsingAgent, entry.path, listing.root)
                          : entry.mediaType
                            ? toggleFile(browsingAgent, entry)
                            : undefined
                      }
                      disabled={!entry.isDirectory && !entry.mediaType}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Folder
                          className={cn(
                            "h-4 w-4 shrink-0",
                            entry.isDirectory ? "text-muted-foreground" : "opacity-0",
                          )}
                        />
                        <span className="truncate">{entry.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                        {entry.mediaType && <Badge variant="secondary">{entry.mediaType}</Badge>}
                        {!entry.isDirectory && formatBytes(entry.size)}
                        {isSelected && <CheckCircle2 className="h-4 w-4 text-primary" />}
                      </span>
                    </button>
                  );
                })}
                {listing.entries.length === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    This folder is empty.
                  </p>
                )}
              </div>
            </>
          )}

          {selected.length > 0 && (
            <div className="space-y-3 rounded border bg-muted/30 p-3">
              <p className="text-sm font-medium">
                {selected.length} file{selected.length === 1 ? "" : "s"} selected
              </p>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  Playback
                  <select
                    className="rounded border bg-background px-2 py-1"
                    value={policy}
                    onChange={(event) => setPolicy(event.target.value as "public" | "signed")}
                  >
                    <option value="public">Public</option>
                    <option value="signed">Signed (token required)</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={subtitle}
                    onChange={(event) => setSubtitle(event.target.checked)}
                  />
                  Generate subtitles
                </label>
                <Button size="sm" onClick={() => void runImport()} disabled={importing}>
                  {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                  Import and transcode
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  Clear
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── queue ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Queue</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transcoding jobs yet.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {jobs.map((job) => (
              <JobRow
                key={job.jobId}
                job={job}
                busy={busy === job.jobId}
                onCancel={() => void cancelJob(job.jobId)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── subcomponents ──────────────────────────────────────────────────────────

function AgentRow({
  agent,
  busy,
  onBrowse,
  onRevoke,
}: {
  agent: AgentHealth;
  busy: boolean;
  onBrowse: () => void;
  onRevoke: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              agent.online ? "bg-green-500" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          <span className="font-medium">{agent.name}</span>
          {!agent.enabled && <Badge variant="secondary">Disabled</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {agent.online ? "Connected" : agent.lastSeenAt ? `Last seen ${new Date(agent.lastSeenAt).toLocaleString()}` : "Never connected"}
          {agent.encoders.length > 0 && ` · ${agent.encoders.map(encoderLabel).join(", ")}`}
          {agent.scratchFreeBytes !== null && ` · ${formatBytes(agent.scratchFreeBytes)} scratch free`}
          {` · ${agent.activeJobs}/${agent.capacityJobs} jobs`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onBrowse} disabled={!agent.enabled || busy}>
          <HardDrive className="h-4 w-4" /> Browse files
        </Button>
        <Button size="sm" variant="ghost" onClick={onRevoke} disabled={busy}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function JobRow({
  job,
  busy,
  onCancel,
}: {
  job: TranscoderJob;
  busy: boolean;
  onCancel: () => void;
}) {
  const waiting = waitingReasonLabel(job.waitingReason);
  const active = ["queued", "claimed", "running", "publishing"].includes(job.state);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{job.title}</span>
          <Badge variant={job.state === "failed" ? "destructive" : "secondary"}>{job.state}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {job.provider === "self-hosted" ? "Your machine" : "Modal"}
          {job.attempts > 0 && ` · attempt ${job.attempts}/${job.maxAttempts}`}
          {waiting && ` · ${waiting}`}
          {job.failureCode && ` · ${job.failureCode}`}
        </p>
      </div>
      {active && (
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
          Cancel
        </Button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <ServerCog className="mx-auto h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-medium">No machines paired yet</p>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        Pair a computer to encode videos on your own hardware. Imported files are
        read from that machine&apos;s folders — not from this browser — so videos that
        never leave your network can still be streamed.
      </p>
    </div>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "error" | "success";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-green-600/30 bg-green-600/5",
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}
