/**
 * Three boundaries, stated as three plain facts. The section used to carry an
 * SVG infrastructure diagram with a stacked fallback; both are gone, because
 * the claim that matters — the bytes are yours — reads better as a sentence
 * than as 11 boxes and 7 arrows.
 */
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

export function OwnershipSection() {
  return (
    <section id="ownership" className="section">
      <div className="content-width">
        <div className="section-header">
          <p className="section-label">Ownership</p>
          <h2 className="section-title">Your files stay in your buckets.</h2>
          <p className="section-intro">
            The API stores object keys and lifecycle state. The bytes stay in
            accounts you control, and nothing about your library is locked to a
            vendor.
          </p>
        </div>

        <ul className="fact-grid">
          {ownershipPoints.map((point) => (
            <li key={point.title} className="fact">
              <h3>{point.title}</h3>
              <p>{point.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
