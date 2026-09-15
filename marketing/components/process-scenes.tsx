import { Lock, Play } from "lucide-react";

import { heroVideo, thumbnails } from "@/lib/media";

/**
 * The three states of one asset moving through the platform. They are plain
 * markup with example data — no live infrastructure calls, and no performance
 * figures that could be read as a benchmark.
 *
 * The same components render in the scroll sequence (desktop) and in the
 * stacked fallback (mobile and reduced motion), so both tell the same story.
 */

const RENDITIONS = [
  { name: "1080p · HLS", detail: "5.2 Mbps", state: "ready" as const },
  { name: "720p · HLS", detail: "2.8 Mbps", state: "ready" as const },
  { name: "480p · HLS", detail: "1.2 Mbps", state: "ready" as const },
  { name: "DASH · manifest.mpd", detail: "adaptive", state: "ready" as const },
];

function CardBar({ label, value }: { label: string; value: string }) {
  return (
    <div className="process-card-bar">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StatusChip({
  state,
  children,
}: {
  state: "ready" | "processing" | "uploading";
  children: React.ReactNode;
}) {
  return (
    <span className="process-status" data-state={state}>
      {children}
    </span>
  );
}

export function UploadScene() {
  return (
    <div className="process-card">
      <CardBar label="Upload / raw bucket" value="multipart · 4 parts" />
      <div className="process-card-body">
        <div className="process-asset">
          <div className="process-thumb">
            <img
              src={thumbnails.coastal}
              alt=""
              width={132}
              height={74}
              loading="lazy"
              decoding="async"
            />
            <span className="process-thumb-tag">01</span>
          </div>
          <div>
            <p className="process-filename">coastal-headland.mp4</p>
            <p className="process-meta">412 MB · 1080p source · direct to R2</p>
            <div className="process-track">
              <span style={{ width: "100%" }} />
            </div>
            <p className="process-meta">4 of 4 parts uploaded</p>
          </div>
        </div>

        <div className="process-rows">
          <div className="process-row">
            <span className="process-row-name">Upload</span>
            <span className="process-row-value">00:00:06</span>
            <StatusChip state="ready">Complete</StatusChip>
          </div>
        </div>

        <p className="example-note">
          Example data. Uploads go straight from the browser to your bucket.
        </p>
      </div>
    </div>
  );
}

export function ProcessScene() {
  return (
    <div className="process-card">
      <CardBar label="Process / transcode" value="FFmpeg · Shaka" />
      <div className="process-card-body">
        <div className="process-asset">
          <div className="process-thumb">
            <img
              src={thumbnails.coastal}
              alt=""
              width={132}
              height={74}
              loading="lazy"
              decoding="async"
            />
            <span className="process-thumb-tag">02</span>
          </div>
          <div>
            <p className="process-filename">coastal-headland.mp4</p>
            <p className="process-meta">
              4 rendition rows written to the transcoded bucket
            </p>
            <div className="process-track">
              <span style={{ width: "100%" }} />
            </div>
            <p className="process-meta">job completed</p>
          </div>
        </div>

        <div className="process-rows">
          {RENDITIONS.map((rendition) => (
            <div key={rendition.name} className="process-row">
              <span className="process-row-name">{rendition.name}</span>
              <span className="process-row-value">{rendition.detail}</span>
              <StatusChip state={rendition.state}>
                {rendition.state === "ready" ? "Ready" : "Working"}
              </StatusChip>
            </div>
          ))}
        </div>

        <p className="example-note">
          Example data. Rendition ladder depends on your source and settings.
        </p>
      </div>
    </div>
  );
}

export function PlayScene() {
  return (
    <div className="process-card process-play">
      <CardBar label="Play / delivery" value="HLS + DASH" />
      <div className="process-card-body">
        <div className="media-frame">
          <img
            src={thumbnails.coastal}
            alt=""
            width={heroVideo.width}
            height={heroVideo.height}
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
            <p className="media-caption">playback / adaptive</p>
          </div>
        </div>

        <div className="process-rows">
          <div className="process-row">
            <span className="process-row-name">Playback policy</span>
            <span className="process-row-value">signed</span>
            <StatusChip state="ready">
              <Lock className="size-3" aria-hidden="true" />
              Token verified
            </StatusChip>
          </div>
          <div className="process-row">
            <span className="process-row-name">Delivery</span>
            <span className="process-row-value">edge Worker</span>
            <StatusChip state="ready">Serving</StatusChip>
          </div>
        </div>

        <p className="example-note">
          Example data. The player is the same component your product ships.
        </p>
      </div>
    </div>
  );
}
