# @openvod/player

A drop-in React video player for self-hosted OpenVOD. Built on [Vidstack](https://vidstack.io) with HLS support, token-based security, optional analytics, chapters, and subtitles.

```bash
npm install @openvod/player
```

There is **no hosted default**. Pass a playback URL (`src`) or your own delivery origin (`cdnBase`). Analytics are off unless you set `analyticsEndpoint`.

## Quick Start (Public Videos)

```tsx
import { OpenVodPlayer } from '@openvod/player'

function App() {
  return (
    <OpenVodPlayer
      playbackId="your-video-id"
      src="https://media.example.com/videos/your-video-id/playlist.m3u8"
    />
  )
}
```

Or resolve from your delivery worker:

```tsx
<OpenVodPlayer
  playbackId="your-video-id"
  cdnBase="https://media.example.com/videos"
/>
```

---

## Integrating with a self-hosted OpenVOD API (signed videos)

For private videos, your application authenticates the viewer, requests a short-lived playback token from **your** OpenVOD API, and passes it to the player.

### Step 1: Request a Playback Token (Your Backend)

Keep your OpenVOD API key (`sk_live_...`) secret. When a user requests to watch a video, your backend calls your API:

```typescript
// Example: Node.js / Next.js API Route
export async function GET(request, { params }) {
  const videoId = params.id;
  const viewerIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const viewerUserAgent = request.headers.get('user-agent');

  const res = await fetch(`${process.env.OPENVOD_API_URL}/v1/video/${videoId}/playback-token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENVOD_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expires_in: "2h",
      viewer_ip: viewerIp,
      viewer_user_agent: viewerUserAgent
    })
  });

  const session = await res.json();
  // { playback_url, token, expires_at, subtitle_url, chapters }
  return Response.json(session);
}
```

### Step 2: Render the Player (Your Frontend)

```tsx
import { useState, useEffect } from 'react';
import { OpenVodPlayer } from '@openvod/player';

function LessonViewer({ videoId }) {
  const [session, setSession] = useState(null);

  useEffect(() => {
    fetch(`/api/videos/${videoId}/play`)
      .then(res => res.json())
      .then(data => setSession(data));
  }, [videoId]);

  if (!session) return <div>Loading...</div>;

  return (
    <OpenVodPlayer
      playbackId={videoId}
      src={session.playback_url}
      token={session.token}
      subtitles={session.subtitle_url}
      chapters={session.chapters}
      title="Advanced React Patterns"
      autoPlay={true}
      theme={{ primaryColor: '#6366f1' }}
    />
  );
}
```

By providing the `token`, the player appends it to video, subtitle, and poster URLs.

---

## Advanced Features

### Chapters & Subtitles

OpenVOD can generate AI subtitles and chapters. The playback-token response includes `subtitle_url` and `chapters`.

```tsx
<OpenVodPlayer
  playbackId="abc-123"
  src="https://media.example.com/videos/abc-123/playlist.m3u8"
  subtitles="https://media.example.com/videos/abc-123/subs.vtt"
  chapters={[
    { startTime: 0, endTime: 60, title: 'Introduction' },
    { startTime: 60, endTime: 300, title: 'Main Content' },
  ]}
/>
```

### Theming

```tsx
<OpenVodPlayer
  src="https://media.example.com/videos/abc-123/playlist.m3u8"
  theme={{
    primaryColor: '#6366f1',
    accentColor: '#f59e0b',
  }}
/>
```

### Analytics (opt-in)

Analytics are **off by default**. Point `analyticsEndpoint` at your own journal URL to send play/pause/seek/heartbeat events:

```tsx
<OpenVodPlayer
  playbackId="abc-123"
  src="https://media.example.com/videos/abc-123/playlist.m3u8"
  analyticsEndpoint="https://api.example.com/api/playback/journal"
  envKey="pk_live_xxxx"
/>
```

---

## Props Reference

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `src` | `string` | — | Direct HLS/DASH URL. Preferred. |
| `cdnBase` | `string` | — | Your delivery origin; used with `playbackId` when `src` is omitted. |
| `playbackId` | `string` | — | Video ID for analytics and `cdnBase` URL construction. |
| `token` | `string` | — | Signed JWT for private content. Appended to video, subtitle, and poster requests. |
| `envKey` | `string` | — | Tenant/environment key for analytics separation. |
| `title` | `string` | — | Video title displayed in the player UI. |
| `poster` | `string` | — | Poster/thumbnail image URL. |
| `subtitles` | `string` | — | VTT subtitle file URL. |
| `chapters` | `Chapter[]` | — | Chapter markers `{ startTime, endTime, title }`. |
| `autoPlay` | `boolean` | `false` | Start playback automatically. |
| `muted` | `boolean` | `false` | Start muted. |
| `theme` | `object` | — | `{ primaryColor?, accentColor? }`. |
| `className` | `string` | — | Additional CSS class. |
| `style` | `object` | — | Inline CSS properties. |
| `analyticsEndpoint` | `string \| false` | off | Your journal URL, or `false` to disable. |
| `onReady` | `() => void` | — | Fired when the video is ready. |
| `onError` | `(err) => void` | — | Fired on playback error. |
| `onEnded` | `() => void` | — | Fired when the video finishes. |

## Requirements

- **React** ≥ 18
- Vidstack is bundled inside the package.

## License

Apache-2.0
