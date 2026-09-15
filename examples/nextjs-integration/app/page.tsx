'use client'

/**
 * The end-to-end demo.
 *
 * 1. `POST /api/upload-token` mints a short-lived upload token on the server
 *    (the API key stays there).
 * 2. `@clipmux/uploader` uploads the file straight to storage with it.
 * 3. While the video is `processing` we poll `GET /api/video-status/[id]` every
 *    5 seconds.
 * 4. Once it is `ready`, the same route hands back a playback token / URL and
 *    `<ClipMuxPlayer>` takes over.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ClipMuxUploader,
  ClipMuxError,
  isUploadAbortedError,
  type UploadProgress,
  type UploadSession,
} from '@clipmux/uploader'
import { ClipMuxPlayer, type Chapter } from '@clipmux/player'

type Phase = UploadProgress['phase'] | 'processing' | 'ready' | 'failed'
type VideoStatus = 'pending' | 'uploading' | 'processing' | 'ready' | 'failed'

/** Shape of `GET /api/video-status/[id]`. */
interface StatusResponse {
  status: VideoStatus
  playbackUrl: string | null
  token: string | null
  subtitleUrl: string | null
  chapters: Chapter[] | null
  error?: string
}

/** Everything the player needs, returned once the video is `ready`. */
interface Playback {
  url: string
  token: string | null
  subtitles: string | null
  chapters: Chapter[] | null
}

/** How long to wait between status polls. */
const POLL_INTERVAL_MS = 5_000

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [videoId, setVideoId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('initializing')
  const [playback, setPlayback] = useState<Playback | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The live upload. `startUpload()` returns a session rather than only a
  // promise, which is what makes Cancel *clean*: `session.cancel()` abandons the
  // multipart upload server-side. Aborting a bare signal stops the browser but
  // leaves the uploaded parts billable in storage and the video row stranded.
  const sessionRef = useRef<UploadSession | null>(null)

  // Never touch state after unmount (a poll or upload can outlive the page).
  // Unmount deliberately does not cancel: navigating away should not throw away
  // the bytes already uploaded — only an explicit Cancel does that.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // ── Polling while the video is transcoding ─────────────────────────
  const applyStatus = useCallback((body: StatusResponse) => {
    if (!mountedRef.current) return
    if (body.status === 'failed') {
      setError('Transcoding failed. Check the API logs, or handle the `video.failed` webhook.')
      setPhase('failed')
      return
    }
    setPhase(body.status === 'ready' ? 'ready' : 'processing')
    if (body.status === 'ready' && body.playbackUrl) {
      setPlayback({
        url: body.playbackUrl,
        token: body.token,
        subtitles: body.subtitleUrl,
        chapters: body.chapters,
      })
    }
  }, [])

  useEffect(() => {
    if (!videoId || phase === 'ready' || phase === 'failed') return

    let cancelled = false

    const poll = async () => {
      try {
        const response = await fetch(`/api/video-status/${videoId}`, { cache: 'no-store' })
        const body = (await response.json()) as StatusResponse
        if (cancelled) return
        if (!response.ok) {
          // 404 (unknown id) and 5xx (API unreachable / bad API key) are
          // terminal — polling would just repeat them, so stop.
          setError(body.error ?? `Status check failed (${response.status})`)
          setVideoId(null)
          return
        }
        applyStatus(body)
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Status check failed')
          setVideoId(null)
        }
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [videoId, phase, applyStatus])

  // ── Upload ─────────────────────────────────────────────────────────
  const uploadFile = async (selected: File) => {
    setError(null)
    setPlayback(null)
    setProgress(null)
    setVideoId(null)
    setPhase('initializing')

    // A signal is still useful: it aborts the in-flight part requests, and
    // `session.cancel()` (Cancel button) aborts *and* cleans up server-side.
    const controller = new AbortController()

    try {
      // 1. Mint the upload token server-side; the API key never reaches here.
      const tokenResponse = await fetch('/api/upload-token', { method: 'POST' })
      const tokenBody = (await tokenResponse.json()) as {
        uploadToken?: string
        error?: string
      }
      if (!tokenResponse.ok || !tokenBody.uploadToken) {
        throw new Error(tokenBody.error ?? 'Could not mint an upload token')
      }

      // 2. Upload straight to storage. `baseUrl` is the API origin only — the
      //    SDK appends `/v1`.
      const baseUrl = process.env.NEXT_PUBLIC_CLIPMUX_API_URL
      if (!baseUrl) {
        throw new Error('NEXT_PUBLIC_CLIPMUX_API_URL is not set')
      }

      const uploader = new ClipMuxUploader({
        baseUrl,
        uploadToken: tokenBody.uploadToken,
      })

      const session = uploader.startUpload(selected, {
        title: selected.name,
        signal: controller.signal,
        onProgress: (next) => {
          if (mountedRef.current) setProgress(next)
        },
      })
      sessionRef.current = session

      const result = await session.run()

      // The upload finished: drop the handle so nothing can cancel it. By now
      // `/complete` has claimed the row and dispatched a transcode job against
      // the object, so a late abort would destroy both.
      sessionRef.current = null

      // 3. The upload is complete; transcoding starts now. Poll from here.
      if (mountedRef.current) {
        setVideoId(result.fileId)
        setPhase('processing')
      }
    } catch (cause) {
      if (!mountedRef.current) return

      if (isUploadAbortedError(cause)) {
        // Cancelling is not a failure — the Cancel button already cleaned up
        // through `session.cancel()`.
        setError('Upload cancelled.')
        setPhase('initializing')
        return
      }

      sessionRef.current = null

      setError(describeError(cause))
      setPhase('initializing')
    }
  }

  // True only while bytes are moving. `phase === 'processing'` means the upload
  // is already done and the server is transcoding.
  const uploadInFlight =
    phase === 'initializing' || phase === 'uploading' || phase === 'paused' || phase === 'completing'
  const canUpload = file !== null && !uploadInFlight && phase !== 'processing'

  return (
    <main>
      <h1>ClipMux · Next.js integration example</h1>
      <p className="lede">
        Upload a video through the browser SDK, watch it transcode, then play it back
        with a signed token.
      </p>

      <section className="card">
        <h2>1 · Upload</h2>

        <label className="field">
          <span>Video file</span>
          <input
            type="file"
            accept="video/*"
            disabled={uploadInFlight}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              setFile(selected)
              setError(null)
              setProgress(null)
              setPhase('initializing')
              setVideoId(null)
              setPlayback(null)
            }}
          />
        </label>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            disabled={!canUpload || uploadInFlight}
            onClick={() => {
              if (file) void uploadFile(file)
            }}
          >
            Upload
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!uploadInFlight}
            onClick={() => {
              // Abandons the multipart upload and deletes the video row.
              void sessionRef.current?.cancel()
            }}
          >
            Cancel
          </button>
        </div>

        {(progress || phase === 'processing' || phase === 'ready') && (
          <>
            <div className="progress">
              <div style={{ width: `${percentFor(progress, phase)}%` }} />
            </div>
            <p className="meta">
              {progress
                ? `${progress.percentage}% · ${formatBytes(progress.bytesUploaded)} of ${formatBytes(
                    progress.bytesTotal,
                  )} · ${progress.partsCompleted}/${progress.partsTotal} parts · ${progress.phase}`
                : `upload complete · ${phase}`}
            </p>
          </>
        )}

        {videoId && (
          <p className="meta">
            video id <code>{videoId}</code> · status <code>{phase}</code>
          </p>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      {playback && videoId && (
        <section className="card">
          <h2>2 · Playback</h2>
          <ClipMuxPlayer
            playbackId={videoId}
            src={playback.url}
            token={playback.token ?? undefined}
            subtitles={playback.subtitles ?? undefined}
            chapters={playback.chapters}
            tokenRefreshEndpoint={`/api/play-token/${videoId}`}
            analyticsEndpoint={`${process.env.NEXT_PUBLIC_CLIPMUX_API_URL ?? ''}/api/playback/journal`}
          />
          <p className="meta">
            Signed URLs expire, so the player refreshes through{' '}
            <code>/api/play-token/{videoId}</code> before that happens.
          </p>
        </section>
      )}
    </main>
  )
}

/** Progress bar percentage for the current phase (kept at 100 while transcoding). */
function percentFor(progress: UploadProgress | null, phase: Phase): number {
  if (!progress) return phase === 'processing' || phase === 'ready' ? 100 : 0
  if (phase === 'processing' || phase === 'ready') return 100
  return progress.percentage
}

/**
 * Errors from `@clipmux/uploader` are typed: match on `error.code` (stable),
 * never on the message. `UploadAbortedError` is handled by the caller.
 */
function describeError(error: unknown): string {
  if (error instanceof ClipMuxError) {
    const retry = error.retryable
      ? ` Retry${error.retryAfterMs ? ` after ${Math.ceil(error.retryAfterMs / 1000)}s` : ''}.`
      : ''
    return `${error.code}: ${error.message}${retry}`
  }
  return error instanceof Error ? error.message : 'Upload failed'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
