import { FileVideo } from "lucide-react";
import type { ReactNode } from "react";

import { StatusChip, type StatusState } from "@/components/status-chip";

/**
 * One library preview and three behaviours, instead of four competing mockups.
 *
 * The preview shows file icons rather than thumbnails: the page ships no
 * imagery below the hero, so a checkout without `public/media` renders a
 * finished row list rather than broken images. There are no invented metrics
 * and no payload dumps — the numbers a real workspace shows belong in the
 * dashboard, not on a marketing page.
 */
const libraryRows: Array<{
  title: string;
  id: string;
  state: StatusState;
  label: string;
}> = [
  { title: "coastal-headland.mp4", id: "vid_9f3a1c", state: "ready", label: "Ready" },
  {
    title: "woodland-canopy.mp4",
    id: "vid_71b0e4",
    state: "processing",
    label: "Processing",
  },
  { title: "wheel-throwing.mov", id: "vid_2ae95b", state: "failed", label: "Failed" },
];

const capabilities: Array<{ title: string; body: ReactNode }> = [
  {
    title: "Signed playback",
    body: "Playback is public or signed, per video. For signed videos your backend mints a short-lived token bound to one viewer, and the delivery Worker verifies it on every manifest and segment request.",
  },
  {
    title: "Webhooks",
    body: (
      <>
        Every lifecycle change — video.ready, video.failed, subtitle and chapter
        events — is delivered signed in{" "}
        <code>X-Webhook-Signature</code> and retried on failure. Verify it
        against the raw request body before parsing.
      </>
    ),
  },
  {
    title: "Usage reporting",
    body: "ClipMux reports the storage and bandwidth it measured, so you can reconcile it against the bills from your own providers.",
  },
];

export function PlatformSection() {
  return (
    <section id="platform" className="section">
      <div className="content-width">
        <div className="section-header">
          <p className="section-label">Platform</p>
          <h2 className="section-title">
            Run your video library with confidence.
          </h2>
          <p className="section-intro">
            What the library looks like, and how access, events, and usage
            behave underneath it.
          </p>
        </div>

        <div className="platform-layout">
          <div className="library-preview">
            <p className="library-preview-title">Example library</p>

            <ul className="library-rows">
              {libraryRows.map((row) => (
                <li key={row.title} className="library-row">
                  <span className="library-icon" aria-hidden="true">
                    <FileVideo className="size-5" />
                  </span>
                  <span className="library-file">
                    <span className="library-name">{row.title}</span>
                    <span className="library-id">{row.id}</span>
                  </span>
                  <StatusChip state={row.state}>{row.label}</StatusChip>
                </li>
              ))}
            </ul>

            <p className="library-note">
              Example data. Your library shows your own assets and their real
              processing states.
            </p>
          </div>

          <dl className="capability-list">
            {capabilities.map((capability) => (
              <div key={capability.title} className="capability">
                <dt>{capability.title}</dt>
                <dd>{capability.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
