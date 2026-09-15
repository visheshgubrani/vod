import { AlertTriangle, FileVideo, ImageOff, Loader2, Play } from "lucide-react";

import { thumbnails } from "@/lib/media";

const libraryRows = [
  {
    title: "coastal-headland.mp4",
    meta: "vid_9f3a1c · 00:42 · public",
    thumb: thumbnails.coastal,
    state: "ready" as const,
    stateLabel: "Ready",
    added: "2 min ago",
  },
  {
    title: "woodland-canopy.mp4",
    meta: "vid_71b0e4 · 01:18 · public",
    thumb: thumbnails.woodland,
    state: "processing" as const,
    stateLabel: "Processing",
    added: "6 min ago",
  },
  {
    title: "facade-study.mp4",
    meta: "vid_4c8d20 · — · signed",
    thumb: thumbnails.architecture,
    state: "uploading" as const,
    stateLabel: "Uploading",
    added: "Just now",
  },
  {
    title: "wheel-throwing.mov",
    meta: "vid_2ae95b · — · public",
    thumb: thumbnails.craft,
    state: "failed" as const,
    stateLabel: "Failed",
    added: "Yesterday",
  },
];

const statusStyles = {
  ready: "border-ready/35 bg-ready/10 text-ready",
  processing: "border-processing/35 bg-processing/10 text-processing",
  uploading: "border-info/35 bg-info/10 text-info",
  failed: "border-failed/35 bg-failed/10 text-failed",
} as const;

function Panel({
  title,
  body,
  className,
  children,
}: {
  title: string;
  body: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`panel ${className ?? ""}`}>
      <div className="panel-head">
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
      <div className="panel-body">{children}</div>
    </article>
  );
}

export function PlatformSection() {
  return (
    <section id="platform" className="section" data-reveal>
      <div className="content-width">
        <div className="section-header">
          <div>
            <p className="section-label">03 / Platform</p>
            <h2 className="section-title">
              Run your video library with confidence.
            </h2>
          </div>
          <p className="section-intro">
            The screens you will actually live in, shown with example data. Every
            figure below is illustrative — none of it is a benchmark.
          </p>
        </div>

        <div className="platform-grid">
          <Panel
            className="panel--library"
            title="Library"
            body="Every asset with its real processing state, the thumbnail that belongs to it, and the actions you need on the row."
          >
            <div className="sample-library">
              <div className="sample-library-head">
                <span>All videos · 4 assets</span>
                <span>Search by title</span>
              </div>

              {libraryRows.map((row) => (
                <div key={row.title} className="sample-row">
                  <div className="sample-thumb">
                    {row.state === "failed" ? (
                      <span className="sample-thumb-placeholder">
                        <ImageOff className="size-5" aria-hidden="true" />
                        <span className="sr-only">
                          Thumbnail unavailable
                        </span>
                      </span>
                    ) : row.state === "uploading" ? (
                      <span className="sample-thumb-placeholder">
                        <FileVideo className="size-5" aria-hidden="true" />
                        <span className="sr-only">
                          Thumbnail generated after upload
                        </span>
                      </span>
                    ) : (
                      <img
                        src={row.thumb}
                        alt=""
                        width={88}
                        height={50}
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="sample-title truncate">{row.title}</p>
                    <p className="sample-meta truncate">{row.meta}</p>
                  </div>

                  <div className="text-right">
                    <span
                      className={`process-status ${statusStyles[row.state]}`}
                      data-state={row.state}
                    >
                      {row.stateLabel}
                    </span>
                    <p className="sample-meta mt-2 hidden sm:block">
                      {row.added}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="example-note">
              Example data. Missing and broken thumbnails fall back to a neutral
              placeholder, and signed assets keep a lock treatment instead of a
              public image URL.
            </p>
          </Panel>

          <Panel
            className="panel--access"
            title="Playback access"
            body="Decide per video whether playback is open or gated, then mint a token for exactly one viewer from your backend."
          >
            <div className="access-switch" aria-hidden="true">
              <span className="access-option">Public</span>
              <span className="access-option" aria-pressed="true">
                Signed
              </span>
            </div>

            <div className="token-sample">
              <div className="token-sample-label">
                <span>app/api/play-token/[id]/route.ts</span>
                <span>Server</span>
              </div>
              <code>{`const session = await vod.playback.createToken(id, {
  expiresIn: "30m",
  viewerUserAgent: req.headers.get("user-agent"),
})

return Response.json({ token: session.token })`}</code>
            </div>

            <div className="media-frame mt-3">
              <img
                src={thumbnails.coastal}
                alt=""
                width={1920}
                height={1080}
                loading="lazy"
                decoding="async"
              />
              <div className="media-scrim">
                <span className="media-button media-button--primary">
                  <Play
                    className="ml-0.5 size-4 fill-current"
                    aria-hidden="true"
                  />
                </span>
                <p className="media-caption">signed · token verified</p>
              </div>
            </div>

            <p className="example-note">
              Example. Playback URLs for signed videos only exist after your
              backend issues a token, and the delivery Worker checks it on every
              request.
            </p>
          </Panel>

          <Panel
            className="panel--webhooks"
            title="Webhooks"
            body="React to the video lifecycle in your own systems instead of polling. This is the payload video.ready actually delivers."
          >
            <div className="payload-sample">
              <div className="token-sample-label">
                <span>POST https://app.example.com/api/webhooks/clipmux</span>
              </div>
              <pre aria-label="Example video.ready webhook payload">{`{
  "id": "evt_8Qd2m4",
  "event": "video.ready",
  "timestamp": "2025-02-14T09:21:07.412Z",
  "data": {
    "videoId": "vid_9f3a1c",
    "title": "coastal-headland",
    "status": "ready",
    "duration": 42.5,
    "hlsUrl": "https://media.example.com/videos/vid_9f3a1c/playlist.m3u8",
    "thumbnailUrl": "https://media.example.com/videos/vid_9f3a1c/thumbnail.jpg"
  }
}`}</pre>
            </div>

            <dl className="delivery-list">
              <div className="delivery-row">
                <dt>Signature header</dt>
                <dd>x-webhook-signature</dd>
              </div>
              <div className="delivery-row">
                <dt>Timestamp header</dt>
                <dd>x-webhook-timestamp</dd>
              </div>
              <div className="delivery-row">
                <dt>Event header</dt>
                <dd>x-webhook-event</dd>
              </div>
              <div className="delivery-row">
                <dt>Retried until delivered</dt>
                <dd>video.ready, video.failed</dd>
              </div>
            </dl>

            <p className="example-note">
              Example. Verify the signature against the raw request body — a
              re-serialized JSON body will not match.
            </p>
          </Panel>

          <Panel
            className="panel--analytics"
            title="Analytics and usage"
            body="Playback behaviour for the library, and the storage and bandwidth you are actually billed for."
          >
            <div className="grid gap-x-8 sm:grid-cols-2">
              <div>
                <p className="sample-meta mb-2">Engagement</p>
                <div className="metric-row">
                  <div>
                    <p className="metric-name">Views</p>
                    <span className="metric-period">Last 30 days</span>
                  </div>
                  <p className="metric-value">
                    1,284<small>plays</small>
                  </p>
                </div>
                <div className="metric-row">
                  <div>
                    <p className="metric-name">Watch time</p>
                    <span className="metric-period">Last 30 days</span>
                  </div>
                  <p className="metric-value">
                    42<small>h</small> 18<small>m</small>
                  </p>
                </div>
                <div className="metric-row">
                  <div>
                    <p className="metric-name">Completion rate</p>
                    <span className="metric-period">Sessions reaching 95%</span>
                  </div>
                  <p className="metric-value">
                    61.4<small>%</small>
                  </p>
                </div>
              </div>

              <div>
                <p className="sample-meta mb-2">Delivery cost drivers</p>
                <div className="metric-row">
                  <div>
                    <p className="metric-name">Storage</p>
                    <span className="metric-period">Billed, current</span>
                  </div>
                  <p className="metric-value">
                    68.4<small>GB</small>
                  </p>
                </div>
                <div className="metric-row">
                  <div>
                    <p className="metric-name">Bandwidth</p>
                    <span className="metric-period">Last 30 days</span>
                  </div>
                  <p className="metric-value">
                    214.6<small>GB</small>
                  </p>
                </div>
                <div className="metric-row">
                  <div>
                    <p className="metric-name">Peak concurrents</p>
                    <span className="metric-period">Last 30 days</span>
                  </div>
                  <p className="metric-value">
                    37<small>viewers</small>
                  </p>
                </div>
              </div>
            </div>

            <p className="example-note flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-[color:var(--muted)]"
                aria-hidden="true"
              />
              Example data. Your provider bills the storage and bandwidth; ClipMux
              reports what it measured.
            </p>
          </Panel>
        </div>

        <p className="sr-only">
          All figures in this section are example data from a demo workspace.
        </p>
        <p className="mt-6 flex items-center gap-2 font-mono text-[13px] text-[color:var(--muted)]">
          <Loader2 className="size-3.5" aria-hidden="true" />
          Demo workspace · one asset shown across every panel
        </p>
      </div>
    </section>
  );
}
