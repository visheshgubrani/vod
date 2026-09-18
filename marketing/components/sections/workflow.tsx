/**
 * One asset moving through a visible process — told as three columns instead of
 * a pinned scroll sequence. There is no active step, no progress rail and no
 * scene stack: all three explanations are on screen at once, on every viewport,
 * with or without JavaScript.
 *
 * The numbers stay because this content really is a sequence.
 */
const STEPS = [
  {
    number: "01",
    title: "Upload",
    body: "The browser uploads windowed multipart parts straight to your raw bucket, with progress you can pause and resume.",
    detail:
      "A dropped connection resumes where it stopped instead of starting the file again.",
  },
  {
    number: "02",
    title: "Process",
    body: "A transcoder turns the source into rendition rows and packages them as HLS and DASH outputs.",
    detail:
      "FFmpeg and Shaka do the work, and the provider that ran the job is recorded on it.",
  },
  {
    number: "03",
    title: "Play",
    body: "The delivery Worker verifies the request and serves the right stream, so the same asset plays in your player.",
    detail:
      "Public or signed: a signed token is checked on every manifest and segment request.",
  },
];

export function WorkflowSection() {
  return (
    <section id="workflow" className="section section--band">
      <div className="content-width">
        <div className="section-header">
          <p className="section-label">Workflow</p>
          <h2 className="section-title">One upload. Ready for playback.</h2>
          <p className="section-intro">
            From the moment a file leaves the browser to the moment a viewer
            presses play.
          </p>
        </div>

        <ol className="step-grid">
          {STEPS.map((step) => (
            <li key={step.number} className="step">
              <span className="step-index" aria-hidden="true">
                {step.number}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <p className="step-detail">{step.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
