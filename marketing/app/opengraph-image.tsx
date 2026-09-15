import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "ClipMux — Your videos. Your infrastructure.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The social card, built from the same tokens as the page: ivory ground,
 * charcoal band, burnt orange accent. Rendered at request time so it can never
 * drift from the palette the way a checked-in PNG would.
 */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#f7f5f0",
          color: "#1a1917",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "space-between",
          padding: "68px 76px",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 14,
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: -0.5,
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "#c2410c",
              borderRadius: 10,
              color: "#ffffff",
              display: "flex",
              height: 44,
              justifyContent: "center",
              width: 44,
            }}
          >
            ▶
          </div>
          ClipMux
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              letterSpacing: -2.5,
              lineHeight: 1,
            }}
          >
            Your videos.
          </div>
          <div
            style={{
              color: "#c2410c",
              fontFamily: "Georgia, serif",
              fontSize: 88,
              letterSpacing: -2,
              lineHeight: 1.06,
            }}
          >
            Your infrastructure.
          </div>
          <div
            style={{
              color: "#5f5c54",
              display: "flex",
              fontSize: 25,
              lineHeight: 1.4,
              marginTop: 30,
              maxWidth: 900,
            }}
          >
            Upload, transcode, and stream with an open-source video platform —
            your buckets, your compute, your product.
          </div>
        </div>

        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div
            style={{
              border: "1px solid rgba(194,65,12,.35)",
              borderRadius: 999,
              color: "#c2410c",
              display: "flex",
              fontFamily: "monospace",
              fontSize: 18,
              padding: "12px 20px",
            }}
          >
            Apache-2.0 · Self-hostable
          </div>
          <div
            style={{
              color: "#8b877d",
              display: "flex",
              fontFamily: "monospace",
              fontSize: 18,
            }}
          >
            R2 · Postgres · Modal
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
