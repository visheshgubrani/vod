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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  FileVideo,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  ServerCog,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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

/**
 * Job state → what it is doing. The states are the server's (`queued`,
 * `claimed`, `running`, `publishing`, `succeeded`, `failed`, `cancelled`); the
 * labels exist so an owner reads "Encoding" rather than "claimed".
 */
const JOB_STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  claimed: "Claimed",
  running: "Encoding",
  publishing: "Publishing",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function jobStateLabel(state: string): string {
  return JOB_STATE_LABELS[state] ?? state;
}

function jobStateVariant(state: string): BadgeVariant {
  if (state === "succeeded") return "ready";
  if (state === "failed") return "failed";
  if (state === "publishing") return "uploading";
  if (state === "queued" || state === "claimed" || state === "running") {
    return "processing";
  }
  return "neutral";
}

const ACTIVE_JOB_STATES = ["queued", "claimed", "running", "publishing"];

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
      <div className="flex items-center gap-2.5 dash-body text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading transcoders…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <Notice tone="error" icon={<AlertCircle className="size-4" />}>
          {error}
        </Notice>
      )}
      {imported && (
        <Notice tone="success" icon={<CheckCircle2 className="size-4" />}>
          {imported}
        </Notice>
      )}

      {/* ── machines ───────────────────────────────────────────────────── */}
      <section aria-labelledby="machines-title" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <h2 id="machines-title" className="dash-section-title text-foreground">
              Machines
            </h2>
            <p className="dash-body mt-1.5 text-muted-foreground">
              A pair of your own computers can encode videos and import files
              that never leave your network. Files are read from the machine, not
              from this browser.
            </p>
          </div>
          <Button onClick={pair} disabled={busy === "pair"}>
            {busy === "pair" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ServerCog className="size-4" aria-hidden="true" />
            )}
            Pair a machine
          </Button>
        </div>

        {pairingCode && (
          <div className="dash-panel-quiet p-5">
            <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <Clock className="size-4 text-processing" aria-hidden="true" />
              Pairing code — valid for 15 minutes, and only once
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="dash-code rounded-xl border border-border bg-background px-4 py-2.5 text-[17px] tracking-[0.14em] text-foreground">
                {pairingCode}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(pairingCode)}
                aria-label="Copy the pairing code to the clipboard"
              >
                <Copy className="size-4" aria-hidden="true" />
                Copy
              </Button>
            </div>
            {pairingCommand && (
              <div className="mt-4">
                <p className="flex items-center gap-2 dash-label">
                  <Terminal className="size-4" aria-hidden="true" />
                  Run this on the machine
                </p>
                <pre className="dash-code-block mt-2 overflow-x-auto p-3.5 text-foreground">
                  {pairingCommand}
                </pre>
              </div>
            )}
          </div>
        )}

        {agents.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <p className="dash-meta">
              <span className="font-mono text-foreground">{onlineAgents.length}</span>{" "}
              of <span className="font-mono text-foreground">{agents.length}</span>{" "}
              {agents.length === 1 ? "machine" : "machines"} connected
            </p>
            <ul className="dash-panel divide-y divide-border-soft overflow-hidden">
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
            </ul>
          </>
        )}
      </section>

      {/* ── browser ────────────────────────────────────────────────────── */}
      {browsingAgent && (
        <section aria-labelledby="browser-title" className="dash-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBrowsingAgent(null);
                  setListing(null);
                  setBrowseError(null);
                }}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                Close
              </Button>
              <h2
                id="browser-title"
                className="dash-section-title min-w-0 truncate text-foreground"
              >
                Files on {browsingAgent.name}
              </h2>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void openBrowser(browsingAgent, listing?.path ?? ".", listing?.root)}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Refresh
            </Button>
          </div>

          <p className="dash-body mt-3 max-w-[62ch] text-muted-foreground">
            These are folders on{" "}
            <span className="font-medium text-foreground">
              {browsingAgent.name}
            </span>
            , not on this browser.
          </p>

          {browseLoading && (
            <div className="mt-4 flex items-center gap-2.5 dash-body text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Asking the machine…
            </div>
          )}
          {browseError && (
            <div className="mt-4">
              <Notice tone="error" icon={<AlertCircle className="size-4" />}>
                {browseError}
              </Notice>
            </div>
          )}

          {listing && (
            <>
              <p className="mt-4 flex items-center gap-2 font-mono text-[13px] text-muted-foreground">
                <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {listing.root ? `${listing.root}/` : ""}
                  {listing.path === "." ? "" : listing.path}
                </span>
              </p>

              <ul className="mt-3 divide-y divide-border-soft overflow-hidden rounded-xl border border-border">
                {listing.path !== "." && (
                  <li>
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-[15px] text-foreground transition-colors hover:bg-panel-strong/50"
                      onClick={() =>
                        void openBrowser(
                          browsingAgent,
                          listing.path.split("/").slice(0, -1).join("/") || ".",
                          listing.root,
                        )
                      }
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      Up one folder
                    </button>
                  </li>
                )}
                {listing.entries.map((entry) => {
                  const isSelected = selected.some((item) => item.identity === entry.identity);
                  const isSelectable = !entry.isDirectory && Boolean(entry.mediaType);
                  return (
                    <li key={entry.path}>
                      <button
                        type="button"
                        aria-pressed={isSelectable ? isSelected : undefined}
                        className={cn(
                          "flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[15px] text-foreground transition-colors",
                          !entry.isDirectory && !entry.mediaType
                            ? "cursor-not-allowed text-faint-foreground"
                            : "hover:bg-panel-strong/50",
                          isSelected && "bg-ember/10",
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
                        <span className="flex min-w-0 items-center gap-2.5">
                          {entry.isDirectory ? (
                            <Folder
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          ) : (
                            <FileVideo
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          {entry.mediaType && (
                            <Badge variant="neutral">{entry.mediaType}</Badge>
                          )}
                          {!entry.isDirectory && (
                            <span className="font-mono text-[13px] text-muted-foreground">
                              {formatBytes(entry.size)}
                            </span>
                          )}
                          {isSelected && (
                            <>
                              <CheckCircle2
                                className="size-4.5 text-ember"
                                aria-hidden="true"
                              />
                              <span className="sr-only">Selected</span>
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {listing.entries.length === 0 && (
                  <li className="px-4 py-8 text-center dash-body text-muted-foreground">
                    This folder is empty.
                  </li>
                )}
              </ul>
            </>
          )}

          {selected.length > 0 && (
            <div className="dash-panel-quiet mt-4 p-4">
              <p className="text-[15px] font-semibold text-foreground">
                {selected.length} file{selected.length === 1 ? "" : "s"} selected
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
                <div className="flex items-center gap-2.5">
                  <label
                    htmlFor="playback-policy"
                    className="text-[15px] font-medium text-foreground"
                  >
                    Playback
                  </label>
                  <select
                    id="playback-policy"
                    className="h-11 rounded-[10px] border border-border bg-background px-3 text-[15px] text-foreground transition-colors hover:border-muted-foreground/40 focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
                    value={policy}
                    onChange={(event) => setPolicy(event.target.value as "public" | "signed")}
                  >
                    <option value="public">Public</option>
                    <option value="signed">Signed (token required)</option>
                  </select>
                </div>
                <label
                  htmlFor="generate-subtitles"
                  className="flex min-h-11 items-center gap-2.5 text-[15px] font-medium text-foreground"
                >
                  <input
                    id="generate-subtitles"
                    type="checkbox"
                    className="size-5 accent-ember"
                    checked={subtitle}
                    onChange={(event) => setSubtitle(event.target.checked)}
                  />
                  Generate subtitles
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => void runImport()} disabled={importing}>
                    {importing && (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    )}
                    Import and transcode
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                    Clear
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── queue ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="queue-title" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="queue-title" className="dash-section-title text-foreground">
            Queue
          </h2>
          {jobs.length > 0 && (
            <p className="dash-meta">
              <span className="font-mono text-foreground">{jobs.length}</span>{" "}
              {jobs.length === 1 ? "job" : "jobs"}
            </p>
          )}
        </div>
        {jobs.length === 0 ? (
          <p className="dash-body text-muted-foreground">No transcoding jobs yet.</p>
        ) : (
          <ul className="dash-panel divide-y divide-border-soft overflow-hidden">
            {jobs.map((job) => (
              <JobRow
                key={job.jobId}
                job={job}
                busy={busy === job.jobId}
                onCancel={() => void cancelJob(job.jobId)}
              />
            ))}
          </ul>
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
  const isFull = agent.capacityJobs > 0 && agent.activeJobs >= agent.capacityJobs;
  const capacityVariant =
    agent.capacityJobs > 0 && agent.activeJobs / agent.capacityJobs > 0.9
      ? "danger"
      : isFull
        ? "warning"
        : "default";

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 transition-colors hover:bg-panel-strong/30 md:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={cn("dash-dot", agent.online ? "status-ready" : "status-idle")}
            aria-hidden="true"
          />
          <span className="text-[15px] font-semibold text-foreground">
            {agent.name}
          </span>
          <span
            className={cn(
              "text-[13px] font-medium",
              agent.online ? "text-ready" : "text-idle",
            )}
          >
            {agent.online ? "Connected" : "Offline"}
          </span>
          {!agent.enabled && <Badge variant="neutral">Disabled</Badge>}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Cpu className="size-4 shrink-0" aria-hidden="true" />
            Capacity{" "}
            <span
              className={cn(
                "font-mono",
                isFull ? "text-processing" : "text-foreground",
              )}
            >
              {agent.activeJobs}/{agent.capacityJobs}
            </span>{" "}
            jobs
          </span>
          {agent.scratchFreeBytes !== null && (
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <HardDrive className="size-4 shrink-0" aria-hidden="true" />
              Scratch{" "}
              <span className="font-mono text-foreground">
                {formatBytes(agent.scratchFreeBytes)}
              </span>{" "}
              free
            </span>
          )}
          {agent.encoders.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {agent.encoders.map((encoder) => (
                <Badge key={encoder} variant="neutral">
                  {encoderLabel(encoder)}
                </Badge>
              ))}
            </span>
          )}
        </div>

        {agent.capacityJobs > 0 && (
          <Progress
            className="mt-3 max-w-64"
            value={agent.activeJobs}
            max={agent.capacityJobs}
            variant={capacityVariant}
          />
        )}

        {!agent.online && (
          <p className="dash-meta mt-2">
            {agent.lastSeenAt
              ? `Last seen ${new Date(agent.lastSeenAt).toLocaleString()}`
              : "Never connected"}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onBrowse} disabled={!agent.enabled || busy}>
          <HardDrive className="size-4" aria-hidden="true" />
          Browse files
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRevoke}
          disabled={busy}
          aria-label={`Revoke ${agent.name}`}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </li>
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
  const active = ACTIVE_JOB_STATES.includes(job.state);

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 transition-colors hover:bg-panel-strong/30 md:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 truncate text-[15px] font-semibold text-foreground">
            {job.title}
          </span>
          <Badge variant={jobStateVariant(job.state)}>
            {jobStateLabel(job.state)}
          </Badge>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
          <span>
            Ran on{" "}
            <span className="text-foreground">
              {job.provider === "self-hosted" ? "your machine" : "Modal"}
            </span>
          </span>
          {job.attempts > 0 && (
            <span>
              Attempt{" "}
              <span className="font-mono text-foreground">
                {job.attempts}/{job.maxAttempts}
              </span>
            </span>
          )}
          <span className="truncate font-mono text-muted-foreground" title={job.jobId}>
            {job.jobId}
          </span>
        </div>

        {waiting && (
          <p className="mt-2 flex items-start gap-2 text-[13px] text-processing">
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {waiting}
          </p>
        )}
        {job.failureCode && (
          <p className="mt-2 flex items-start gap-2 text-[13px] text-danger">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-mono">{job.failureCode}</span>
          </p>
        )}
      </div>

      {active && (
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <XCircle className="size-4" aria-hidden="true" />
          )}
          Cancel
        </Button>
      )}
    </li>
  );
}

function EmptyState() {
  return (
    <div className="dash-panel flex flex-col items-center border-dashed px-6 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full border border-border bg-panel-strong text-muted-foreground">
        <ServerCog className="size-6" aria-hidden="true" />
      </span>
      <p className="mt-5 text-lg font-semibold text-foreground">
        No machines paired yet
      </p>
      <p className="dash-body mt-2 max-w-[62ch] text-muted-foreground">
        Pair a computer to encode videos on your own hardware. Imported files are
        read from that machine&apos;s folders — not from this browser — so videos
        that never leave your network can still be streamed.
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
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-4 text-sm",
        tone === "error"
          ? "border-failed/35 bg-failed/10 text-danger"
          : "border-ready/35 bg-ready/10 text-ready",
      )}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="dash-body">{children}</span>
    </div>
  );
}
