# @clipmux/player

A drop-in React video player with built-in analytics, theming, and HLS support. Powered by [Vidstack](https://vidstack.io) — batteries included.

```bash
npm install @clipmux/player
```

## Quick Start

```tsx
import { ClipMuxPlayer } from '@clipmux/player'

function App() {
  return <ClipMuxPlayer playbackId="your-video-id" />
}
```

That's it. No CSS imports, no extra dependencies — it just works.

## Usage

### Basic Playback

```tsx
<ClipMuxPlayer playbackId="abc-123" />
```

The player resolves the video URL automatically from the `playbackId`.

### Signed / Private Videos

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  token="eyJhbGciOiJIUzI1NiIs..."
/>
```

The `token` is appended to the playback URL as a query parameter for secure delivery.
When provided, the same token is also appended to `subtitles` and `poster` URLs (if set).

### Custom Source (Escape Hatch)

If you use your own CDN or proxy, pass `src` directly. Keep `playbackId` so analytics still tracks correctly:

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  src="https://my-cdn.example.com/videos/abc-123/playlist.m3u8"
/>
```

### Full Example

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  envKey="pk_live_xxxxxxxx"
  token="eyJ..."
  title="Product Demo"
  poster="https://cdn.example.com/thumb.jpg"
  subtitles="https://cdn.example.com/subs-en.vtt"
  chapters={[
    { startTime: 0, endTime: 30, title: 'Intro' },
    { startTime: 30, endTime: 120, title: 'Features' },
    { startTime: 120, endTime: 180, title: 'Pricing' },
  ]}
  autoPlay
  muted
  theme={{ primaryColor: '#6366f1' }}
  onReady={() => console.log('Player loaded')}
  onEnded={() => console.log('Finished')}
  onError={(err) => console.error('Playback error:', err)}
/>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `playbackId` | `string` | — | ClipMux video ID. Resolves to the HLS URL automatically. |
| `src` | `string` | — | Direct HLS/DASH URL. Overrides `playbackId` for playback. |
| `envKey` | `string` | — | Tenant/environment key for multi-tenant analytics. |
| `token` | `string` | — | Signed playback token for private content (auto-appended to playback, subtitles, and poster URLs). |
| `title` | `string` | — | Video title displayed in the player UI. |
| `poster` | `string` | — | Poster/thumbnail image URL. |
| `subtitles` | `string` | — | VTT subtitle file URL. |
| `chapters` | `Chapter[]` | — | Chapter markers (converted to VTT internally). |
| `autoPlay` | `boolean` | `false` | Auto-play on load. |
| `muted` | `boolean` | `false` | Start muted. |
| `theme` | `object` | — | `{ primaryColor?, accentColor? }` — customize player colors. |
| `className` | `string` | — | Additional CSS class on the player container. |
| `style` | `CSSProperties` | — | Inline styles on the player container. |
| `analyticsEndpoint` | `string \| false` | Production URL | Override the analytics beacon URL. Set to `false` to disable. |
| `onReady` | `() => void` | — | Fired when the player is ready to play. |
| `onError` | `(err: Error) => void` | — | Fired on playback error. |
| `onEnded` | `() => void` | — | Fired when the video finishes. |

## Analytics

The player sends playback analytics automatically:

- **Events tracked**: `play`, `pause`, `seeking`, `seeked`, `ended`, `error`
- **Heartbeat**: Every 10 seconds with accumulated `watchedDelta`
- **Reliability**: Uses `navigator.sendBeacon` on page unload to guarantee delivery
- **Session tracking**: A unique `sessionId` (UUID) is generated per player mount

### Disable Analytics

```tsx
<ClipMuxPlayer playbackId="abc-123" analyticsEndpoint={false} />
```

### Custom Analytics Endpoint

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  analyticsEndpoint="https://your-proxy.example.com/v1/beacon"
/>
```

The endpoint receives `POST` requests with a JSON array of events:

```json
[
  {
    "event": "heartbeat",
    "ts": "2026-02-16T10:30:00.000Z",
    "videoId": "abc-123",
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "envKey": "pk_live_xxx",
    "currentTime": 45.2,
    "duration": 180,
    "watchedDelta": 10.1
  }
]
```

## Theming

Customize the player accent color using the `theme` prop:

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  theme={{
    primaryColor: '#6366f1', // Indigo
    accentColor: '#f59e0b',  // Amber
  }}
/>
```

`primaryColor` maps to the Vidstack `--video-brand` CSS variable. You can also override styles via the `.clipmux-player` CSS class.

## Chapters

Pass chapter markers as an array — they're converted to WebVTT internally:

```tsx
<ClipMuxPlayer
  playbackId="abc-123"
  chapters={[
    { startTime: 0, endTime: 60, title: 'Introduction' },
    { startTime: 60, endTime: 300, title: 'Main Content' },
    { startTime: 300, endTime: 360, title: 'Conclusion' },
  ]}
/>
```

## Requirements

- **React** ≥ 18
- No other peer dependencies — Vidstack is bundled inside the package.

## License

MIT
