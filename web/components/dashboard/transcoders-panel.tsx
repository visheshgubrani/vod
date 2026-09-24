"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Cpu,
  FileVideo,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  ServerCog,
  XCircle,
} from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type DirectoryListing,
  type LocalWorkerStatus,
  type TranscoderJob,
  encoderLabel,
  formatBytes,
  pollControl,
  transcoderApi,
  waitingReasonLabel,
} from "@/lib/transcoder-api";
import { cn } from "@/lib/utils";

type SelectedFile = {
  rootName: string;
  relativePath: string;
  fileName: string;
  identity: string;
  sizeBytes: number;
};

const JOB_STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  claimed: "Claimed",
  running: "Encoding",
  publishing: "Publishing",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const ACTIVE_JOB_STATES = ["queued", "claimed", "running", "publishing"];

function jobStateLabel(state: string): string {
  return JOB_STATE_LABELS[state] ?? state;
}

function jobStateVariant(state: string): BadgeVariant {
  if (state === "succeeded") return "ready";
  if (state === "failed") return "failed";
  if (state === "publishing") return "uploading";
  if (ACTIVE_JOB_STATES.includes(state)) return "processing";
  return "neutral";
}

export function TranscodersPanel({ activeOrganizationId }: { activeOrganizationId: string }) {
  const [status, setStatus] = useState<LocalWorkerStatus | null>(null);
  const [jobs, setJobs] = useState<TranscoderJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
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
      const [workerReply, jobReply] = await Promise.all([
        transcoderApi.worker(),
        transcoderApi.jobs(50),
      ]);
      setStatus(workerReply);
      setJobs(jobReply.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load encoding status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const worker = status?.worker ?? null;
  const canImport = Boolean(
    status?.provider === "local" &&
      status.importAvailable &&
      worker?.online &&
      status.importOrganizationId === activeOrganizationId,
  );

  async function openBrowser(path = ".", rootName?: string) {
    setBrowsing(true);
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const { controlId } = await transcoderApi.browse({ path, rootName: rootName ?? listing?.root });
      setListing(await pollControl<DirectoryListing>(controlId));
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Could not read that folder");
      setListing(null);
    } finally {
      setBrowseLoading(false);
    }
  }

  function toggleFile(entry: { path: string; name: string; identity: string; size: number }) {
    setSelected((current) => {
      if (current.some((item) => item.identity === entry.identity)) {
        return current.filter((item) => item.identity !== entry.identity);
      }
      return [
        ...current,
        {
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
    if (!canImport || selected.length === 0) return;
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
          idempotencyKey: `dash:${file.identity}`,
        });
      }
      const reply = await transcoderApi.import(items);
      const created = reply.imports.filter((entry) => !entry.deduplicated).length;
      const deduped = reply.imports.length - created;
      setImported(deduped ? `${created} queued, ${deduped} already imported` : `${created} queued for encoding`);
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

  if (loading) {
    return <div className="flex items-center gap-2.5 dash-body text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading encoding status…</div>;
  }

  return (
    <div className="space-y-8">
      {error && <Notice tone="error" icon={<AlertCircle className="size-4" />}>{error}</Notice>}
      {imported && <Notice tone="success" icon={<CheckCircle2 className="size-4" />}>{imported}</Notice>}

      <section aria-labelledby="encoding-provider-title" className="space-y-4">
        <div>
          <h2 id="encoding-provider-title" className="dash-section-title text-foreground">Encoding provider</h2>
          <p className="dash-body mt-1.5 text-muted-foreground">New jobs use the provider configured for this ClipMux deployment.</p>
        </div>
        <div className="dash-panel flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-panel-strong text-muted-foreground">
              <ServerCog className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-foreground">{status?.provider === "modal" ? "Modal" : "This machine"}</p>
              {status?.provider === "modal" ? (
                <p className="dash-body mt-1 text-muted-foreground">
                  {status.modalConfigured
                    ? "Modal configuration is complete."
                    : "Modal configuration is incomplete or invalid. Check the deployment health status."}
                </p>
              ) : (
                <>
                  <p className="dash-body mt-1 text-muted-foreground">
                    <span className={cn("mr-2 inline-block size-2 rounded-full align-middle", worker?.online ? "bg-ready" : "bg-muted-foreground")} />
                    {worker?.online ? "Local worker online" : "Local worker offline"}
                    {worker?.hostname ? ` · ${worker.hostname}` : ""}
                  </p>
                  {worker?.online && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 dash-meta">
                      <span><Cpu className="mr-1 inline size-3.5" aria-hidden="true" />{worker.activeJobs}/{worker.capacityJobs} jobs</span>
                      {worker.encoders.map((encoder) => <Badge key={encoder} variant="neutral">{encoderLabel(encoder)}</Badge>)}
                    </div>
                  )}
                  {!worker?.online && <p className="dash-meta mt-1">{worker?.lastSeenAt ? `Last heartbeat ${new Date(worker.lastSeenAt).toLocaleString()}` : "The worker has not connected yet."}</p>}
                </>
              )}
            </div>
          </div>
          {status?.provider === "local" && (
            <Button variant="secondary" onClick={() => void openBrowser()} disabled={!canImport}>
              <FolderOpen className="size-4" aria-hidden="true" />Browse local files
            </Button>
          )}
        </div>
        {status?.provider === "local" && !canImport && (
          <p className="dash-meta">
            {!worker?.online
              ? "Start the local worker to browse and import files."
              : !status.importAvailable
                ? "Host-folder imports are available to an owner or admin in the configured import organization."
                : "Select the configured import organization to browse and import host files."}
          </p>
        )}
      </section>

      {browsing && (
        <section aria-labelledby="browser-title" className="dash-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setBrowsing(false); setListing(null); setSelected([]); }}><ArrowLeft className="size-4" aria-hidden="true" />Close</Button>
              <h2 id="browser-title" className="dash-section-title text-foreground">Files on this machine</h2>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void openBrowser(listing?.path ?? ".", listing?.root)}><RefreshCw className="size-4" aria-hidden="true" />Refresh</Button>
          </div>
          <p className="dash-body mt-3 text-muted-foreground">Choose files from folders mounted into the local worker. The browser never reads these folders.</p>
          {browseLoading && <p className="mt-4 flex items-center gap-2 dash-body text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Reading local folders…</p>}
          {browseError && <div className="mt-4"><Notice tone="error" icon={<AlertCircle className="size-4" />}>{browseError}</Notice></div>}
          {listing && (
            <>
              <p className="mt-4 flex items-center gap-2 font-mono text-[13px] text-muted-foreground"><FolderOpen className="size-4" aria-hidden="true" />{listing.root}{listing.path === "." ? "" : `/${listing.path}`}</p>
              <ul className="mt-3 divide-y divide-border-soft overflow-hidden rounded-xl border border-border">
                {listing.path !== "." && <li><button type="button" className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-foreground hover:bg-panel-strong/50" onClick={() => void openBrowser(listing.path.split("/").slice(0, -1).join("/") || ".", listing.root)}><Folder className="size-4" aria-hidden="true" />Up one folder</button></li>}
                {listing.entries.map((entry) => {
                  const isSelected = selected.some((item) => item.identity === entry.identity);
                  const selectable = !entry.isDirectory && Boolean(entry.mediaType);
                  return <li key={entry.path}><button type="button" aria-pressed={selectable ? isSelected : undefined} disabled={!entry.isDirectory && !entry.mediaType} className={cn("flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-foreground", !entry.isDirectory && !entry.mediaType ? "cursor-not-allowed text-faint-foreground" : "hover:bg-panel-strong/50", isSelected && "bg-ember/10")} onClick={() => entry.isDirectory ? void openBrowser(entry.path, listing.root) : selectable ? toggleFile(entry) : undefined}>
                    <span className="flex min-w-0 items-center gap-2.5">{entry.isDirectory ? <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <FileVideo className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}<span className="truncate">{entry.name}</span></span>
                    <span className="flex shrink-0 items-center gap-3">{entry.mediaType && <Badge variant="neutral">{entry.mediaType}</Badge>}{!entry.isDirectory && <span className="font-mono text-[13px] text-muted-foreground">{formatBytes(entry.size)}</span>}{isSelected && <CheckCircle2 className="size-4 text-ember" aria-hidden="true" />}</span>
                  </button></li>;
                })}
                {listing.entries.length === 0 && <li className="px-4 py-8 text-center dash-body text-muted-foreground">This folder is empty.</li>}
              </ul>
            </>
          )}
          {selected.length > 0 && <div className="dash-panel-quiet mt-4 p-4">
            <p className="text-[15px] font-semibold text-foreground">{selected.length} file{selected.length === 1 ? "" : "s"} selected</p>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <label htmlFor="playback-policy" className="flex items-center gap-2 text-[15px] font-medium text-foreground">Playback<select id="playback-policy" className="h-10 rounded-lg border border-border bg-background px-3" value={policy} onChange={(event) => setPolicy(event.target.value as "public" | "signed")}><option value="public">Public</option><option value="signed">Signed</option></select></label>
              <label htmlFor="generate-subtitles" className="flex items-center gap-2 text-[15px] font-medium text-foreground"><input id="generate-subtitles" type="checkbox" className="size-5 accent-ember" checked={subtitle} onChange={(event) => setSubtitle(event.target.checked)} />Generate subtitles</label>
              <Button onClick={() => void runImport()} disabled={importing || !canImport}>{importing && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Import and encode</Button>
              <Button variant="ghost" onClick={() => setSelected([])}>Clear</Button>
            </div>
          </div>}
        </section>
      )}

      <section aria-labelledby="queue-title" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="queue-title" className="dash-section-title text-foreground">Queue</h2>{jobs.length > 0 && <p className="dash-meta"><span className="font-mono text-foreground">{jobs.length}</span> jobs in this organization</p>}</div>
        {jobs.length === 0 ? <p className="dash-body text-muted-foreground">No encoding jobs yet.</p> : <ul className="dash-panel divide-y divide-border-soft overflow-hidden">{jobs.map((job) => <JobRow key={job.jobId} job={job} busy={busy === job.jobId} onCancel={() => void cancelJob(job.jobId)} />)}</ul>}
      </section>
    </div>
  );
}

function JobRow({ job, busy, onCancel }: { job: TranscoderJob; busy: boolean; onCancel: () => void }) {
  const waiting = waitingReasonLabel(job.waitingReason);
  const active = ACTIVE_JOB_STATES.includes(job.state);
  return <li className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 md:px-5">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><span className="min-w-0 truncate text-[15px] font-semibold text-foreground">{job.title}</span><Badge variant={jobStateVariant(job.state)}>{jobStateLabel(job.state)}</Badge></div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground"><span>Provider <span className="text-foreground">{job.provider === "local" ? "This machine" : "Modal"}</span></span>{job.attempts > 0 && <span>Attempt <span className="font-mono text-foreground">{job.attempts}/{job.maxAttempts}</span></span>}<span className="truncate font-mono" title={job.jobId}>{job.jobId}</span></div>
      {waiting && <p className="mt-2 flex items-start gap-2 text-[13px] text-processing"><Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{waiting}</p>}
      {job.failureCode && <p className="mt-2 flex items-start gap-2 text-[13px] text-danger"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span className="font-mono">{job.failureCode}</span></p>}
    </div>
    {active && <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <XCircle className="size-4" aria-hidden="true" />}Cancel</Button>}
  </li>;
}

function Notice({ tone, icon, children }: { tone: "error" | "success"; icon: ReactNode; children: ReactNode }) {
  return <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-xl border p-4 text-sm", tone === "error" ? "border-failed/35 bg-failed/10 text-danger" : "border-ready/35 bg-ready/10 text-ready")}><span className="mt-0.5 shrink-0" aria-hidden="true">{icon}</span>{children}</div>;
}
