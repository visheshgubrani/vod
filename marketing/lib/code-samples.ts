import { thumbnails } from "@/lib/media";

export type CodeTabId = "token" | "upload" | "play" | "events";

export type ResultRow = { label: string; value: string };

export type CodeTab = {
  id: CodeTabId;
  label: string;
  file: string;
  scope: "Server" | "Browser";
  code: string;
  resultTitle: string;
  rows?: ResultRow[];
  /** Renders an upload progress strip instead of a key/value list. */
  progress?: { percentage: number; partsCompleted: number; partsTotal: number };
  /** Renders a player preview instead of a key/value list. */
  player?: boolean;
  note: string;
};

/**
 * Every excerpt below is the usage documented by the working Next.js
 * integration in `examples/nextjs-integration`, which is compiled on every
 * commit. Field names come from `server-sdk/src/types.ts` and the component
 * props from `player/src/ClipMuxPlayer.tsx` — nothing here is invented.
 */
export const codeTabs: CodeTab[] = [
  {
    id: "token",
    label: "Create a token",
    file: "app/api/upload-token/route.ts",
    scope: "Server",
    code: `import { ClipMux } from "@clipmux/server";

const vod = new ClipMux({
  apiKey: process.env.CLIPMUX_API_KEY!,
  baseUrl: process.env.CLIPMUX_API_URL!,
});

// The API key never leaves this route.
export async function POST() {
  const token = await vod.uploads.createToken({
    expiresIn: "1h",
    maxFiles: 1,
  });

  return Response.json({
    uploadToken: token.upload_token,
    expiresAt: token.expires_at,
  });
}`,
    resultTitle: "200 OK",
    rows: [
      { label: "upload_token", value: "ut_9f3a1c…" },
      { label: "expires_at", value: "2025-02-14T10:21:07.412Z" },
      { label: "max_files", value: "1" },
    ],
    note: "Example response. The token is checked when an upload starts, so a slow upload is never cut off by its own token lapsing.",
  },
  {
    id: "upload",
    label: "Upload",
    file: "app/upload-form.tsx",
    scope: "Browser",
    code: `import { ClipMuxUploader } from "@clipmux/uploader";

// The upload token comes from the route above.
const uploader = new ClipMuxUploader({ baseUrl, uploadToken });

const session = uploader.startUpload(file, {
  title: file.name,
  playbackPolicy: "signed",
  onProgress: ({ percentage }) => setProgress(percentage),
});

const result = await session.run();
// result.fileId — poll GET /v1/video/:id, or wait for video.ready`,
    resultTitle: "Upload in progress",
    progress: { percentage: 78, partsCompleted: 3, partsTotal: 4 },
    note: "Example progress. `startUpload` returns a session, so pause, resume and cancel act on the real multipart upload.",
  },
  {
    id: "play",
    label: "Play",
    file: "app/video-player.tsx",
    scope: "Browser",
    code: `import { ClipMuxPlayer } from "@clipmux/player";

<ClipMuxPlayer
  playbackId={video.id}
  src={playbackUrl}
  token={token}
  tokenRefreshEndpoint="/api/play-token"
  title={video.title}
  poster={video.thumbnail_url ?? undefined}
/>`,
    resultTitle: "Player preview",
    player: true,
    note: "Example. For signed videos, supply a token and point tokenRefreshEndpoint at a same-origin route that can authorize the viewer.",
  },
  {
    id: "events",
    label: "Receive events",
    file: "app/api/webhooks/clipmux/route.ts",
    scope: "Server",
    code: `import { constructWebhookEvent } from "@clipmux/server";

export async function POST(req: Request) {
  // The RAW body — re-serializing JSON changes the signed bytes.
  const rawBody = await req.text();

  const event = await constructWebhookEvent({
    secret: process.env.CLIPMUX_WEBHOOK_SECRET!,
    rawBody,
    signature: req.headers.get("x-webhook-signature"),
    timestamp: req.headers.get("x-webhook-timestamp"),
    event: req.headers.get("x-webhook-event"),
  });

  if (event.event === "video.ready") {
    await publishVideo(event.data.videoId);
  }

  return Response.json({ received: true });
}`,
    resultTitle: "Signature verified",
    rows: [
      { label: "id", value: "evt_8Qd2m4" },
      { label: "event", value: "video.ready" },
      { label: "data.videoId", value: "vid_9f3a1c" },
      { label: "data.hlsUrl", value: "…/playlist.m3u8" },
    ],
    note: "Example delivery. Verify before parsing; a forged or stale signature is a 400, not a retry.",
  },
];

export const playerPreviewThumb = thumbnails.coastal;
