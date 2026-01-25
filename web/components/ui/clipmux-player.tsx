'use client'

import { MediaPlayer, MediaProvider, Track } from '@vidstack/react'
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from '@vidstack/react/player/layouts/default'

import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import './clipmux-player.css'

type ClipMuxPlayerProps = {
  src: string
  title?: string
  thumbnails?: string
  subtitles?: string
}

export function ClipMuxPlayer({
  src,
  title,
  thumbnails,
  subtitles,
}: ClipMuxPlayerProps) {
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
