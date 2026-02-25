# @clipmux/player

A beautiful, drop-in React video player engineered for the ClipMux video platform. Built on top of [Vidstack](https://vidstack.io) with baked-in analytics, HLS support, token-based security, chapters, and subtitles.

```bash
npm install @clipmux/player
```

## Quick Start (Public Videos)

For public videos that don't require secure signed tokens, integration is a single line:

```tsx
import { ClipMuxPlayer } from '@clipmux/player'
import '@clipmux/player/dist/index.css' // if applicable or if styles are extracted

function App() {
  return <ClipMuxPlayer playbackId="your-video-id" />
}
```

That's it. It automatically resolves the HLS URL and begins securely sending playback analytics.

---

## Integrating with the ClipMux API (Private/Signed Videos)

For secure, private videos (the default), your application needs to authenticate the user, request a short-lived playback token from the ClipMux backend, and securely pass that to the player.

### Step 1: Request a Playback Token (Your Backend)

Your backend should keep your ClipMux API key (`sk_live_...`) secret. When a user requests to watch a video, your backend calls the ClipMux API to get a temporary session.

```typescript
// Example: Node.js / Next.js API Route
export async function GET(request, { params }) {
  const videoId = params.id;
  const viewerIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const viewerUserAgent = request.headers.get('user-agent');
  
  // 1. Verify your user has access to this video first!
  // ...
  
  // 2. Request a signed token from ClipMux
  const clipmuxRes = await fetch(`https://api.clipmux.com/v1/video/${videoId}/playback-token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CLIPMUX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expires_in: "2h",
      viewer_ip: viewerIp,               // Bind token to real viewer IP
      viewer_user_agent: viewerUserAgent // Bind token to viewer User-Agent
    })
  });

  const session = await clipmuxRes.json();
  
  // session returns: { playback_url, token, expires_at, subtitle_url, chapters }
  return Response.json(session);
}
```

### Step 2: Render the Player (Your Frontend)

Fetch the session from your backend, and pass the properties directly into `<ClipMuxPlayer>`.

```tsx
import { useState, useEffect } from 'react';
import { ClipMuxPlayer } from '@clipmux/player';

function LessonViewer({ videoId }) {
  const [session, setSession] = useState(null);

  useEffect(() => {
    // Fetch the session from YOUR backend
    fetch(`/api/videos/${videoId}/play`)
      .then(res => res.json())
      .then(data => setSession(data));
  }, [videoId]);

  if (!session) return <div>Loading...</div>;

  return (
    <ClipMuxPlayer
      playbackId={videoId}
      token={session.token}             // Secure playback token
      subtitles={session.subtitle_url}  // Auto-loads AI generated subtitles
      chapters={session.chapters}       // Auto-generates chapter markers
      
      // Optional customizations
      title="Advanced React Patterns"
      autoPlay={true}
      theme={{ primaryColor: '#6366f1' }}
    />
  );
}
```

By providing the `token`, the player automatically appends it to all requested resources (video segments, subtitle tracks, and thumbnails), preventing unauthorized access.

---

## Advanced Features

### Chapters & Subtitles
ClipMux can auto-generate AI subtitles and chapters. When fetching your playback token, the API will return `subtitle_url` and `chapters`. Passing these to the player automatically renders them using native WebVTT.

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  subtitles="https://delivery.clipmux.com/.../subs.vtt"
  chapters={[
    { startTime: 0, endTime: 60, title: 'Introduction' },
    { startTime: 60, endTime: 300, title: 'Main Content' },
  ]}
/>
```

### Theming
Customize the player to match your brand. `primaryColor` updates the timeline scrubber and main buttons.

```tsx
<ClipMuxPlayer
  // ...
  theme={{
    primaryColor: '#6366f1', // Indigo
    accentColor: '#f59e0b',  // Amber
  }}
/>
```

### Analytics
The player securely tracks real-time analytics (heartbeat, play/pause, seek, watch time) out of the box.

If you are using environments or multiple tenants, you can differentiate metrics by passing an environment key:
```tsx
<ClipMuxPlayer playbackId="abc-123" envKey="pk_live_xxxx" />
```

To entirely disable analytics:
```tsx
<ClipMuxPlayer playbackId="abc-123" analyticsEndpoint={false} />
```

### Custom Sources (Escape Hatch)
If you are proxying the video through your own CDN, provide a `src` explicitly. `playbackId` is still strongly recommended so analytics continue to log properly against the video entity.

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  src="https://my-custom-cdn.com/videos/abc-123/playlist.m3u8"
/>
```

---

## Props Reference

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `playbackId` | `string` | — | **Required.** The ClipMux video ID. Automatically resolves the secure delivery URL. |
| `token` | `string` | — | Signed JWT for private content. Securely appended to video, subset, and poster requests. |
| `src` | `string` | — | Direct HLS/DASH URL. Overrides the auto-resolved URL from `playbackId`. |
| `envKey` | `string` | — | Tenant/environment key for multi-tenant analytics separation. |
| `title` | `string` | — | Video title displayed in the player UI heading. |
| `poster` | `string` | — | Custom poster/thumbnail image URL. |
| `subtitles` | `string` | — | VTT subtitle file URL (AI generated or custom). |
| `chapters` | `Chapter[]` | — | Array of chapter markers `{ startTime, endTime, title }`. |
| `autoPlay` | `boolean` | `false` | Start playback automatically when loaded. |
| `muted` | `boolean` | `false` | Start player muted. |
| `theme` | `object` | — | `{ primaryColor?, accentColor? }` to customize UI colors. |
| `className` | `string` | — | Additional CSS class for the player container. |
| `style` | `object` | — | Inline CSS properties. |
| `analyticsEndpoint` | `string \| false` | `default` | Custom analytics ingestion endpoint, or `false` to disable. |
| `onReady` | `() => void` | — | Fired when the video is loaded and ready to play. |
| `onError` | `(err) => void` | — | Fired on playback error. |
| `onEnded` | `() => void` | — | Fired when the video naturally finishes. |

## Requirements

- **React** ≥ 18
- No other peer dependencies — Vidstack is fully bundled inside the package to avoid version conflicts.

## License

MIT
