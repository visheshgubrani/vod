'use client'

import * as React from 'react'
import { MediaPlayer, MediaProvider, Track } from '@vidstack/react'
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from '@vidstack/react/player/layouts/default'

import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import './clipmux-player.css'

type Chapter = {
  startTime: number
  endTime: number
  title: string
}

type ClipMuxPlayerProps = {
  src: string
  title?: string
  thumbnails?: string
  subtitles?: string
  chapters?: Chapter[] | null
}

/**
 * Convert chapters array to VTT format string
 */
function chaptersToVtt(chapters: Chapter[]): string {
  let vtt = 'WEBVTT\n\n'
  
  chapters.forEach((ch, idx) => {
    const formatTime = (seconds: number) => {
      const h = Math.floor(seconds / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const s = seconds % 60
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
    }
    
    vtt += `${idx + 1}\n`
    vtt += `${formatTime(ch.startTime)} --> ${formatTime(ch.endTime)}\n`
    vtt += `${ch.title}\n\n`
  })
  
  return vtt
}

export function ClipMuxPlayer({
  src,
  title,
  thumbnails,
  subtitles,
  chapters,
}: ClipMuxPlayerProps) {
  // Convert chapters to VTT data URL
  const chaptersVttUrl = React.useMemo(() => {
    if (!chapters || chapters.length === 0) return null
    const vtt = chaptersToVtt(chapters)
    return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`
  }, [chapters])

  return (
    <MediaPlayer className="media-player" title={title} src={src}>
      <MediaProvider>
        {subtitles ? (
          <Track
            src={subtitles}
            kind="subtitles"
            label="English"
            lang="en"
            default
          />
        ) : null}
        {chaptersVttUrl ? (
          <Track
            src={chaptersVttUrl}
            kind="chapters"
            label="Chapters"
            lang="en"
            default
          />
        ) : null}
      </MediaProvider>
      <DefaultVideoLayout
        thumbnails={thumbnails}
        icons={defaultLayoutIcons}
        menuGroup="bottom"
        smallLayoutWhen={({ width }) => width < 520}
      />
    </MediaPlayer>
  )
}
