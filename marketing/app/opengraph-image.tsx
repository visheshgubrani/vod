import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "OpenVOD — Your video. Your platform.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#f7f5f0",
          color: "#19181d",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "space-between",
          padding: "72px 78px",
          position: "relative",
          width: "100%",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 14, fontSize: 26, fontWeight: 700 }}>
          <div style={{ alignItems: "center", background: "#6940d9", borderRadius: 50, color: "#f7f5f0", display: "flex", height: 44, justifyContent: "center", width: 44 }}>▶</div>
          OpenVOD
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 82, fontWeight: 700, letterSpacing: -5, lineHeight: 1 }}>Your video.</div>
          <div style={{ color: "#6940d9", fontFamily: "Georgia", fontSize: 88, fontStyle: "italic", letterSpacing: -5, lineHeight: 1.03 }}>Your platform.</div>
          <div style={{ color: "#65616d", fontFamily: "monospace", fontSize: 17, letterSpacing: 2, marginTop: 24 }}>OPEN-SOURCE VIDEO INFRASTRUCTURE</div>
        </div>
        <div style={{ border: "1px solid rgba(105,64,217,.24)", borderRadius: 999, color: "#6940d9", fontFamily: "monospace", fontSize: 13, padding: "10px 16px", width: "fit-content" }}>UPLOAD / TRANSCODE / STREAM</div>
      </div>
    ),
    { ...size },
  );
}
