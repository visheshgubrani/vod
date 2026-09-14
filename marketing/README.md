# OpenVOD marketing site

The standalone marketing site lives here so its typography, motion lifecycle,
and public conversion links do not couple to the dashboard.

```bash
pnpm --filter openvod-marketing dev
```

Production builds require the destinations in [`.env.example`](./.env.example).
They are deployment configuration: the app does not provide form APIs, billing,
authentication, or hosted waitlist storage.

The site uses local `next/font/local` assets, Tailwind + the shadcn component
conventions, Motion for local UI interactions, and GSAP/ScrollTrigger + Lenis
for desktop scroll choreography. The walkthrough has a poster fallback and
uses `public/walkthrough.mp4` when available.
