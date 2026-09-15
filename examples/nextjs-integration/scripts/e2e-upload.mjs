#!/usr/bin/env node
/**
 * Manual end-to-end upload script.
 *
 * This is NOT part of `next build` and is not a test: it talks to a real server,
 * writes real bytes into your storage, and spends a real transcode job. Run it
 * by hand against a **running local ClipMux stack**.
 *
 * It does exactly what `app/api/upload-token/route.ts` + `app/page.tsx` do, but
 * from Node, so a failing upload can be told apart from a failing browser:
 *
 *   1. mint an upload token with the server SDK (API key auth)
 *   2. create the multipart upload
 *   3. upload the file with the browser SDK (same code path as the page)
 *   4. print the video id, then poll until it is `ready` or `failed`
 *
 * Usage (from anywhere in the repo):
 *
 *   CLIPMUX_API_KEY=sk_live_… \
 *   CLIPMUX_API_URL=http://localhost:8787 \
 *   node examples/nextjs-integration/scripts/e2e-upload.mjs ./clip.mp4
 *
 * Options:
 *   --title <title>      video title (default: the file name)
 *   --signed             request a `signed` playback policy
 *   --subtitles          also generate subtitles + chapters
 *   --no-wait            return as soon as the upload completes
 *   --watch <videoId>    skip the upload and just poll an existing video
 *
 * Prerequisites:
 *   - `pnpm --filter ./sdk build && pnpm --filter ./server-sdk build`
 *     (this script imports both packages from their `dist/`)
 *   - a running API (`pnpm dev`) with uploads enabled and `CLIPMUX_API_KEY` set
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { ClipMux, ClipMuxError } from '@clipmux/server'
import { ClipMuxUploader, ClipMuxError as UploaderError, isUploadAbortedError } from '@clipmux/uploader'

/** How long to wait between status polls while transcoding. */
const POLL_INTERVAL_MS = 5_000
/** Give up after this many polls (~5 minutes at the interval above). */
const MAX_POLLS = 60
/**
 * Signed playback tokens are bound to the viewer's User-Agent. There is no
 * browser here, so use a fixed, obviously-fake one — it must match whatever
 * plays the returned URL.
 */
const VIDEO_READY_USER_AGENT = 'clipmux-e2e-script/1.0'

const USAGE = `usage: node scripts/e2e-upload.mjs <file> [--title <t>] [--signed] [--subtitles] [--no-wait]
       node scripts/e2e-upload.mjs --watch <videoId>`

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2))

  const apiKey = process.env.CLIPMUX_API_KEY
  if (!apiKey) {
    fail('CLIPMUX_API_KEY is not set (use a sk_live_… key from your deployment)')
  }

  // No `/v1` suffix — both SDKs append it.
  const baseUrl = process.env.CLIPMUX_API_URL ?? 'http://localhost:8787'

  const vod = new ClipMux({ apiKey, baseUrl })

  if (values.watch) {
    await waitForReady(vod, values.watch)
    return
  }

  const filePath = values.file
  if (!filePath) fail(USAGE)

  const title = values.title ?? path.basename(filePath)
  const playbackPolicy = flags.has('signed') ? 'signed' : 'public'
  const generateSubtitle = flags.has('subtitles')
  const shouldWait = !flags.has('no-wait')

  let contents
  try {
    contents = await readFile(filePath)
  } catch (cause) {
    fail(`cannot read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const info = await stat(filePath)
  if (info.size === 0) fail(`${filePath} is empty`)

  // 1. Mint the upload token — the same call the example's route handler makes.
  console.log(`→ minting an upload token (${baseUrl})`)
  const token = await vod.uploads.createToken({ expiresIn: '1h', maxFiles: 1 })
  console.log(`  token ${token.upload_token.slice(0, 12)}…  expires ${token.expires_at}`)

  // 2/3. Upload. Node has no `File`, so pass a `Blob` plus an explicit filename.
  const uploader = new ClipMuxUploader({ baseUrl, uploadToken: token.upload_token })
  const blob = new Blob([contents])

  console.log(`→ uploading ${filePath} (${(info.size / 1024 / 1024).toFixed(1)} MiB) as "${title}"`)

  let result
  let lastPercent = -1
  try {
    result = await uploader.upload(blob, {
      filename: path.basename(filePath),
      title,
      playbackPolicy,
      generateSubtitle,
      generateChapters: generateSubtitle,
      onProgress: (progress) => {
        // The part plan is only known after `/create`, so the first callback
        // carries `partsTotal: 0`.
        const parts = progress.partsTotal > 0 ? ` · ${progress.partsCompleted}/${progress.partsTotal} parts` : ''
        if (progress.percentage !== lastPercent) {
          lastPercent = progress.percentage
          // stderr, so piping stdout still yields just the summary.
          process.stderr.write(`\r  ${progress.percentage}% (${progress.phase})${parts}      `)
        }
      },
    })
  } catch (cause) {
    if (isUploadAbortedError(cause)) fail('upload aborted')
    fail(describeError(cause))
  }

  process.stderr.write('\n')
  console.log(`✔ upload complete`)
  console.log(`  video id     ${result.fileId}`)
  console.log(`  status       ${result.status}`)
  console.log(`  key          ${result.key}`)
  console.log(`  multipart id ${result.uploadId}`)
  console.log(`  bytes        ${result.bytesUploaded} in ${result.partCount} part(s)`)

  if (!shouldWait) {
    console.log(`\nPoll it yourself: node scripts/e2e-upload.mjs --watch ${result.fileId}`)
    return
  }

  await waitForReady(vod, result.fileId)
}

/**
 * Minimal argv parsing: `--flag`, `--key value`, and one positional file.
 *
 *   node scripts/e2e-upload.mjs clip.mp4 --title "Keynote" --signed
 */
function parseArgs(argv) {
  const takesValue = new Set(['--title', '--watch'])
  const values = {}
  const flags = new Set()
  const positional = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (takesValue.has(arg)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value\n${USAGE}`)
      values[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--')) {
      flags.add(arg.slice(2))
    } else {
      positional.push(arg)
    }
  }

  values.file = positional[0]
  return { values, flags }
}

/** Poll `GET /v1/video/:id` until the video is playable (or dead). */
async function waitForReady(vod, videoId, { polls = MAX_POLLS } = {}) {
  console.log(`\n→ polling ${videoId} every ${POLL_INTERVAL_MS / 1000}s`)
  for (let attempt = 1; attempt <= polls; attempt += 1) {
    const video = await vod.videos.get(videoId)

    if (video.status === 'ready') {
      console.log(`✔ ready after ${attempt} poll(s)`)
      // A signed playback token is bound to the viewer's User-Agent, so this
      // script has to *pretend to be the viewer*. In the app this value comes
      // from `request.headers.get('user-agent')` — see
      // app/api/video-status/[id]/route.ts.
      const session = await vod.playback.createToken(videoId, {
        expiresIn: '1h',
        viewerUserAgent: VIDEO_READY_USER_AGENT,
      })
      console.log(`  playback url ${session.playback_url ?? '(none)'}`)
      console.log(`  token        ${session.token ? `${session.token.slice(0, 24)}…` : '(public — none needed)'}`)
      console.log(`  subtitles    ${session.subtitle_url ?? '(none)'}`)
      console.log(`  chapters     ${session.chapters ? `${session.chapters.length}` : '(none)'}`)
      console.log(`\nOpen http://localhost:3000 and check the video id in your dashboard.`)
      return
    }

    if (video.status === 'failed') {
      // Transcoding reports stable `error_code`s — see docs/delivery-contract.md.
      fail(`transcoding failed for ${videoId} — check the API/transcoder logs`)
    }

    console.log(`  ${attempt}/${polls}: ${video.status}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  fail(`gave up waiting for ${videoId} after ${polls} polls`)
}

function describeError(error) {
  if (error instanceof UploaderError || error instanceof ClipMuxError) {
    const retry = error.retryable ? ' (retryable)' : ''
    return `${error.code}: ${error.message}${retry}`
  }
  return error instanceof Error ? error.message : String(error)
}

function fail(message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

main().catch((error) => fail(describeError(error)))
