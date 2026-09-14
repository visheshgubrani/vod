# @openvod/player

A drop-in React player for self-hosted [OpenVOD](https://github.com/visheshgubrani/vod),
built on [Vidstack](https://vidstack.io): HLS/DASH, signed playback tokens with
automatic refresh, AI-generated chapters and subtitles, and opt-in analytics.

```bash
npm install @openvod/player
```

There is **no hosted default**. Pass a playback URL (`src`) or your own delivery
origin (`cdnBase` + `playbackId`). Analytics are off unless you set
`analyticsEndpoint` — the component never phones home on its own.

## Public videos

```tsx
import { OpenVodPlayer } from '@openvod/player'

<OpenVodPlayer
  playbackId="your-video-id"
  src="https://media.example.com/videos/your-video-id/playlist.m3u8"
  title="My Video"
/>
```

Or let the player build the URL from your delivery origin:

```tsx
<OpenVodPlayer playbackId="your-video-id" cdnBase="https://media.example.com/videos" />
```

> **Prefer `src` whenever you have the URL.** `cdnBase` builds
> `{cdnBase}/{playbackId}/playlist.m3u8`, which matches output encoded by the
> Modal worker. Videos encoded by a **self-hosted agent** are published under
> `videos/<id>/attempts/<attempt-id>/playlist.m3u8` (attempts are scoped so a
> superseded encode cannot overwrite the live one), so the shortcut would 404.
> The playback URL from `vod.playback.createToken()` or the `video.ready`
> webhook already points at the right prefix — pass it as `src`.

## Private (signed) videos

Your backend mints a short-lived playback token and the player appends it to
the manifest, poster and subtitle URLs.

```tsx
<OpenVodPlayer
  playbackId={videoId}
  src={session.playback_url}   // the API's own field names
  token={session.token}
  subtitles={session.subtitle_url}
  chapters={session.chapters}
  title={video.title}
  // Refresh the token before it expires — see below.
  tokenRefreshEndpoint={`/api/videos/${videoId}/play-token`}
/>
```

Mint the token on your server, forwarding the **viewer's** user-agent: signed
tokens are bound to it by default.

```ts
// app/api/videos/[id]/play-token/route.ts
import { OpenVod } from '@openvod/server'

const vod = new OpenVod({
  apiKey: process.env.OPENVOD_API_KEY!,
  baseUrl: process.env.OPENVOD_API_URL!, // your API origin, no /v1 suffix
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await vod.playback.createToken(id, {
    expiresIn: '2h',
    // Required for signed videos: the delivered token is bound to this UA.
    viewerUserAgent: req.headers.get('user-agent') ?? undefined,
    allowedDomains: ['app.example.com'],
  })

  // The player accepts { token }, { playback_token } or { playback_url }.
  return Response.json({ token: session.token, expiresAt: session.expires_at })
}
```

### Token refresh

A token that expires mid-playback would stop playback, so the player asks for a
new one shortly before that happens (60s by default) and swaps it into the
stream without interrupting anything.

`tokenRefreshEndpoint` accepts either:

```tsx
// 1. A URL, fetched with credentials: 'include' (same-origin session routes).
tokenRefreshEndpoint="/api/videos/123/play-token"

// 2. A callback, for a cross-origin API, a signed request, or a token cache.
tokenRefreshEndpoint={async () => {
  const res = await fetch('/api/play-token', { headers: { 'x-csrf': token } })
  return res.json() // { token } / { playback_token } / { playback_url } all work
}}
```

The response may be a token string, `{ token }`, `{ playback_token }`, or
`{ playback_url }` (the token is read out of the query string).

Failures never interrupt playback. They back off exponentially (1s → 60s) and
stop after 5 consecutive failures rather than hammering your endpoint.

## Chapters and subtitles

```tsx
<OpenVodPlayer
  src={playbackUrl}
  token={token}
  subtitles="https://media.example.com/videos/abc-123/subs.vtt"
  chapters={[
    { startTime: 0, endTime: 60, title: 'Introduction' },
    { startTime: 60, endTime: 300, title: 'Main content' },
  ]}
/>
```

Chapters are converted to a WebVTT track internally. With
`generateSubtitle`/`generateChapters` set at upload time, the OpenVOD API
returns both on the playback-token response.

## Theming

```tsx
<OpenVodPlayer
  src={playbackUrl}
  theme={{ primaryColor: '#6366f1', accentColor: '#f59e0b' }}
  className="rounded-xl"
/>
```

`primaryColor` maps to `--video-brand`, `accentColor` to `--video-accent`. For
anything deeper, override Vidstack's own CSS variables in your stylesheet.

## Analytics (opt-in)

Analytics are **off** by default. Point `analyticsEndpoint` at the OpenVOD API's
journal route and pass a `userId` to attribute sessions:

```tsx
<OpenVodPlayer
  playbackId={videoId}
  src={playbackUrl}
  userId={currentUser.id}
  analyticsEndpoint="https://api.example.com/api/playback/journal"
/>
```

The player batches `play`, `pause`, `seeking`, `seeked`, `ended`, `error` and
10-second `heartbeat` events with accumulated watch time. Watch time only counts
while playing and not seeking, so scrubbing does not inflate it. Flushes use
`navigator.sendBeacon` on unload so the last batch survives navigation.

> The journal route currently accepts unauthenticated events. If your analytics
> drive business decisions, keep it behind your own proxy until per-tenant
> public keys land.

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | — | Direct HLS/DASH URL. Takes precedence over `cdnBase`. |
| `cdnBase` | `string` | — | Your delivery origin; used with `playbackId`. |
| `playbackId` | `string` | — | Video id — used for `cdnBase` URLs and analytics. |
| `token` | `string` | — | Signed token, appended to video/poster/subtitle URLs. |
| `tokenRefreshEndpoint` | `string \| () => Promise<...>` | — | Where to get a fresh token. |
| `tokenRefreshLeadMs` | `number` | `60000` | How early to refresh. |
| `userId` | `string` | — | Viewer identity for analytics. |
| `title` | `string` | — | Shown in the player chrome. |
| `poster` | `string` | — | Poster image. |
| `subtitles` | `string` | — | WebVTT subtitle URL. |
| `chapters` | `Chapter[]` | — | `{ startTime, endTime, title }[]`. |
| `autoPlay` / `muted` | `boolean` | `false` | Deferred playback. |
| `theme` | `{ primaryColor?, accentColor? }` | — | CSS variable theming. |
| `className` / `style` | `string` / `CSSProperties` | — | Applied to the container. |
| `analyticsEndpoint` | `string \| false` | off | Journal URL. |
| `onReady` | `() => void` | — | Fired once per source. |
| `onError` | `(err: Error) => void` | — | Playback error. |
| `onEnded` | `() => void` | — | Playback finished. |

`envKey` is accepted as a deprecated alias for `userId`.

## Styling and bundle size

Styles are inlined into the JS bundle, so there is nothing extra to import. If
you want them as a real CSS asset instead (strict CSP, smaller JS chunk):

```ts
import '@openvod/player/styles.css'
```

Do not do both. The package is ~800 KB unpacked (Vidstack is bundled, React is
external); it tree-shakes with your bundler, and the CSS asset split removes
~65 KB from the JS.

## Requirements

- **React 18 or 19** (peer).
- Delivery responses must allow cross-origin reads — the OpenVOD delivery worker
  sends `Access-Control-Allow-Origin: *`, so this works out of the box.

## License

Apache-2.0
