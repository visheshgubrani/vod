import { Check } from "lucide-react";

/* ── Diagram data ───────────────────────────────────────────────────
 *
 * One source of truth for the SVG and the stacked mobile fallback, so the two
 * can never disagree about what sits inside which boundary. Coordinates are in
 * the SVG's own 900×672 user space; `diagram-shell` scales the whole thing to
 * the column width.
 */

type DiagramNode = {
  id: string;
  group: string;
  title: string;
  detail?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type DiagramGroup = {
  id: string;
  title: string;
  note: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type DiagramEdge = {
  id: string;
  d: string;
  label: string;
  labelX: number;
  labelY: number;
};

const diagramGroups: DiagramGroup[] = [
  {
    id: "app",
    title: "Your application",
    note: "Your account, your repo",
    x: 10,
    y: 8,
    w: 360,
    h: 150,
  },
  {
    id: "platform",
    title: "ClipMux deployment",
    note: "The open-source app you run",
    x: 10,
    y: 196,
    w: 360,
    h: 150,
  },
  {
    id: "storage",
    title: "Your Cloudflare account",
    note: "R2 buckets and the delivery Worker",
    x: 10,
    y: 384,
    w: 360,
    h: 224,
  },
  {
    id: "compute",
    title: "Transcode compute",
    note: "Modal, or a host you operate",
    x: 470,
    y: 196,
    w: 380,
    h: 150,
  },
  {
    id: "viewers",
    title: "Your viewers",
    note: "Playback inside your product",
    x: 470,
    y: 384,
    w: 380,
    h: 150,
  },
];

const diagramNodes: DiagramNode[] = [
  { id: "backend", group: "app", title: "Your backend", detail: "API key", x: 26, y: 76, w: 150, h: 64 },
  { id: "ui", group: "app", title: "Your product UI", detail: "browser", x: 196, y: 76, w: 150, h: 64 },

  { id: "api", group: "platform", title: "ClipMux API", detail: "Hono, either runtime", x: 26, y: 264, w: 150, h: 64 },
  { id: "db", group: "platform", title: "Postgres", detail: "lifecycle state", x: 196, y: 264, w: 150, h: 64 },

  { id: "raw", group: "storage", title: "Raw bucket", detail: "R2", x: 26, y: 458, w: 150, h: 64 },
  { id: "transcoded", group: "storage", title: "Transcoded bucket", detail: "R2", x: 196, y: 458, w: 150, h: 64 },
  { id: "delivery", group: "storage", title: "Delivery Worker", detail: "verifies tokens, rewrites manifests", x: 26, y: 548, w: 320, h: 58 },

  { id: "modal", group: "compute", title: "Modal GPU runner", detail: "FFmpeg + Shaka", x: 486, y: 264, w: 150, h: 64 },
  { id: "agent", group: "compute", title: "Self-hosted agent", detail: "your machines", x: 660, y: 264, w: 150, h: 64 },

  { id: "player", group: "viewers", title: "Your player", detail: "HLS or DASH", x: 486, y: 458, w: 150, h: 64 },
  { id: "browser", group: "viewers", title: "Any browser", detail: "signed or public", x: 660, y: 458, w: 150, h: 64 },
];

/*
 * Seven connections tell the whole story. Two of them run around the outside of
 * the column, which is what keeps the inner boxes free of crossing lines; the
 * single crossing that remains is where "job input" and "HLS + DASH renditions"
 * travel in opposite directions along the bottom.
 */
const diagramEdges: DiagramEdge[] = [
  { id: "key", d: "M330 158 V 196", label: "your API key", labelX: 340, labelY: 188 },
  { id: "dispatch", d: "M370 296 H 470", label: "job dispatch", labelX: 380, labelY: 288 },
  { id: "presigned", d: "M100 346 V 458", label: "presigned parts", labelX: 110, labelY: 372 },
  { id: "manifests", d: "M330 522 V 548", label: "manifests + segments", labelX: 42, labelY: 540 },
  { id: "playback", d: "M362 577 H 440 V 490 H 486", label: "playback", labelX: 372, labelY: 569 },
  { id: "input", d: "M100 522 V 648 H 440 V 296 H 486", label: "job input", labelX: 180, labelY: 640 },
  { id: "renditions", d: "M810 296 H 876 V 628 H 250 V 522", label: "HLS + DASH renditions", labelX: 520, labelY: 620 },
];

const ownershipPoints = [
  {
    title: "Own the media",
    body: "Raw uploads and every processed output live in your own R2 buckets. ClipMux stores object keys and lifecycle state, never the bytes.",
  },
  {
    title: "Choose the compute",
    body: "Run transcoding on Modal's GPU runners, or point a self-hosted agent at machines you already operate. The provider is recorded per job, so playback is unaffected either way.",
  },
  {
    title: "Control access",
    body: "Your backend decides who receives a signed playback token, and the delivery Worker verifies every manifest and segment request against it.",
  },
];

const providers = [
  "Cloudflare R2",
  "Cloudflare Workers",
  "Postgres",
  "Modal",
  "Self-hosted agents",
];

function DiagramSvg() {
  return (
    <svg
      viewBox="0 0 900 672"
      role="img"
      aria-label="Infrastructure diagram. Your backend talks to the ClipMux API using your API key. The API mints presigned upload parts into your raw R2 bucket and dispatches transcode jobs to Modal or a self-hosted agent. Finished HLS and DASH renditions land in your transcoded R2 bucket. The delivery Worker verifies playback tokens and serves your viewers."
    >
      <defs>
        <marker
          id="ownership-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="var(--faint)" />
        </marker>
      </defs>

      {diagramGroups.map((group) => (
        <g key={group.id}>
          <rect
            x={group.x}
            y={group.y}
            width={group.w}
            height={group.h}
            rx="16"
            fill="var(--paper)"
            stroke="var(--hairline-strong)"
          />
          <text
            x={group.x + 18}
            y={group.y + 34}
            fill="var(--brand)"
            fontFamily="var(--font-geist-mono), monospace"
            fontSize="15"
            letterSpacing="1.2"
          >
            {group.title.toUpperCase()}
          </text>
          <text
            x={group.x + 18}
            y={group.y + 57}
            fill="var(--muted)"
            fontFamily="var(--font-manrope), sans-serif"
            fontSize="13.5"
          >
            {group.note}
          </text>
        </g>
      ))}

      {diagramEdges.map((edge) => (
        <g key={edge.id}>
          <path
            d={edge.d}
            fill="none"
            stroke="var(--faint)"
            strokeWidth="1.4"
            markerEnd="url(#ownership-arrow)"
          />
          <text
            x={edge.labelX}
            y={edge.labelY}
            fill="var(--muted)"
            fontFamily="var(--font-geist-mono), monospace"
            fontSize="13"
          >
            {edge.label}
          </text>
        </g>
      ))}

      {diagramNodes.map((node) => (
        <g key={node.id}>
          <rect
            x={node.x}
            y={node.y}
            width={node.w}
            height={node.h}
            rx="10"
            fill="var(--surface)"
            stroke="var(--hairline-strong)"
          />
          <text
            x={node.x + 14}
            y={node.detail ? node.y + 29 : node.y + 37}
            fill="var(--ink)"
            fontFamily="var(--font-manrope), sans-serif"
            fontSize="16.5"
            fontWeight="600"
          >
            {node.title}
          </text>
          {node.detail ? (
            <text
              x={node.x + 14}
              y={node.y + 50}
              fill="var(--muted)"
              fontFamily="var(--font-geist-mono), monospace"
              fontSize="12.5"
            >
              {node.detail}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

function DiagramFallback() {
  return (
    <div className="diagram-fallback">
      {diagramGroups.map((group) => (
        <section key={group.id} className="diagram-group">
          <h3>{group.title}</h3>
          <p>{group.note}</p>
          <ul>
            {diagramNodes
              .filter((node) => node.group === group.id)
              .map((node) => (
                <li key={node.id}>
                  {node.title}
                  {node.detail ? <span>{node.detail}</span> : null}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function OwnershipSection() {
  return (
    <section id="ownership" className="section" data-reveal>
      <div className="content-width">
        <div className="section-header">
          <div>
            <p className="section-label">01 / Ownership</p>
            <h2 className="section-title">Your files stay in your buckets.</h2>
          </div>
          <p className="section-intro">
            Nothing about your library is locked inside a vendor. The API writes
            object keys into Postgres, the delivery Worker reads from your
            buckets, and every boundary in this diagram belongs to an account you
            control.
          </p>
        </div>

        <div className="ownership-grid">
          <div>
            <ol className="ownership-points">
              {ownershipPoints.map((point, index) => (
                <li key={point.title} className="ownership-point">
                  <span className="point-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-3 border-t border-[color:var(--hairline)] pt-6 text-[15px] font-semibold text-[color:var(--muted)]">
              {providers.map((provider) => (
                <li key={provider} className="inline-flex items-center gap-2">
                  <Check
                    className="size-4 text-[color:var(--brand)]"
                    aria-hidden="true"
                  />
                  {provider}
                </li>
              ))}
            </ul>
          </div>

          <div className="diagram-shell">
            <DiagramSvg />
          </div>

          <DiagramFallback />
        </div>
      </div>
    </section>
  );
}
