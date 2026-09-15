# Marketing media

This directory holds the footage and stills the marketing page references. The
files themselves are supplied separately — everything below is the contract the
components already expect. Drop a file at the listed path with the listed
dimensions and it appears; no code change is needed.

`lib/media.ts` is the single place these paths are written down. If you rename a
file, change it there.

## Required files

| Path | Kind | Dimensions | Used by |
|---|---|---|---|
| `hero-1080.mp4` | video | 1920×1080, H.264/AAC, ≤5 MB | Hero frame, all breakpoints ≥768px |
| `hero-720.mp4` | video | 1280×720, H.264/AAC, ≤2.5 MB | Hero frame below 768px |
| `hero-poster.jpg` | image | 1920×1080, progressive JPEG | Hero poster, LCP element |
| `clips/woodland.mp4` | video | 1920×1080 | Supporting demo asset |
| `clips/woodland-poster.jpg` | image | 1920×1080 | Poster for the above |
| `clips/architecture.mp4` | video | 1920×1080 | Supporting demo asset |
| `clips/architecture-poster.jpg` | image | 1920×1080 | Poster for the above |
| `clips/craft.mp4` | video | 1920×1080 | Supporting demo asset |
| `clips/craft-poster.jpg` | image | 1920×1080 | Poster for the above |
| `thumbs/coastal.jpg` | image | 1280×720 | Library rows, workflow scenes, player preview |
| `thumbs/woodland.jpg` | image | 1280×720 | Library rows |
| `thumbs/architecture.jpg` | image | 1280×720 | Library rows |
| `thumbs/craft.jpg` | image | 1280×720 | Library rows |

Overrides live in `MARKETING_HERO_VIDEO_URL`, `MARKETING_HERO_VIDEO_MOBILE_URL`
and `MARKETING_HERO_POSTER_URL` (see `.env.example`) for deployments that serve
the hero from a CDN.

## The hero recording

A 24-second sequence assembled from the clips above and app captures:

| Time | Content |
|---|---|
| 0–4s | Coastal footage, natural colour, strong composition |
| 4–9s | The same asset entering the redesigned upload interface |
| 9–15s | Processing state, then verified playback outputs |
| 15–20s | The ready asset open in the video detail screen |
| 20–24s | Playback of the original footage, returning to the opening |

Record it against **demo fixtures**, not a real tenant. The on-page caption
already reads "Demo recording — processing time condensed": keep that true, and
do not present the edit as a transcoding benchmark.

App captures must exclude tokens, API keys, and signed playback URLs. Use dummy
credentials and an isolated fixture workspace.

## Provenance

Pexels permits free website and promotional use subject to its
[license](https://www.pexels.com/license/). Record one row per source before
launch — the licence reference and download date are the parts that are easy to
lose and impossible to reconstruct later.

| Local file | Source URL | Creator | Downloaded | Licence |
|---|---|---|---|---|
| `hero-1080.mp4`, `thumbs/coastal.jpg` | _add Pexels URL_ | _add creator_ | _YYYY-MM-DD_ | [Pexels License](https://www.pexels.com/license/) |
| `clips/woodland.mp4`, `thumbs/woodland.jpg` | _add Pexels URL_ | _add creator_ | _YYYY-MM-DD_ | [Pexels License](https://www.pexels.com/license/) |
| `clips/architecture.mp4`, `thumbs/architecture.jpg` | _add Pexels URL_ | _add creator_ | _YYYY-MM-DD_ | [Pexels License](https://www.pexels.com/license/) |
| `clips/craft.mp4`, `thumbs/craft.jpg` | _add Pexels URL_ | _add creator_ | _YYYY-MM-DD_ | [Pexels License](https://www.pexels.com/license/) |

Choose natural colour and clean compositions, with no visible branding. Generate
posters from the actual selected clips rather than from stills.

## Encoding notes

- MP4 (H.264 + AAC) only — the page ships a single `<source>` per breakpoint.
- Faststart (`-movflags +faststart`) so playback can begin before the file is
  fully downloaded.
- No audio track is required. The frame is muted and always has been; dropping
  the audio track saves bytes for no loss.
- Keep the interface legible over decorative detail. If a clip has to lose
  quality to fit the size budget, take it out of the footage, not the UI.
