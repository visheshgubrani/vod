import Link from "next/link";
import { Navigation } from "@/components/navigation";
import { ClusterHealth } from "@/components/dashboard/cluster-health";
import { Badge } from "@/components/ui/badge";
import { APP_NAME, GITHUB_URL } from "@/lib/site";

const BADGES = ["HLS + DASH", "Cloudflare R2", "Modal GPU", "Apache-2.0"];

// The public API is mounted at the origin root (/v1/...), which is why the
// SDK takes the bare origin — not an /api or /v1 URL.
const CURL_SNIPPET = [
  "# 1. Mint a short-lived upload token with your API key, on your server",
  'curl -X POST https://api.example.com/v1/upload/token \\',
  '  -H "Authorization: Bearer $CLIPMUX_API_KEY" \\',
  '  -H "Content-Type: application/json" \\',
  '  -d \'{ "expires_in": "1h", "max_files": 1 }\'',
  "",
  "# 2. The browser uploads with that token — no key, no storage credentials",
];

const REACT_SNIPPET = [
  'import { ClipMuxUploader } from "@clipmux/uploader";',
  "",
  "const uploader = new ClipMuxUploader({",
  '  baseUrl: "https://api.example.com", // your API origin, no /v1 suffix',
  "  uploadToken, // minted by your backend in step 1",
  "});",
  "",
  "const video = await uploader.upload(file, {",
  '  title: "My first video",',
  "  playbackPolicy: \"signed\",",
  '  onProgress: ({ percentage }) => console.log(`${percentage}%`),',
  "});",
  "",
  "// video.fileId — play it with <ClipMuxPlayer /> once it is ready",
];

const KEYWORDS = new Set(["curl", "import", "from", "const", "new", "await", "npm"]);

function highlightLine(line: string): React.ReactNode {
  if (/^\s*(#|\/\/)/.test(line)) {
    return <span className="text-muted-foreground">{line}</span>;
  }

  // Split the line into alternating code / quoted-string segments.
  const segments: { text: string; quoted: boolean }[] = [];
  let buffer = "";
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote !== null) {
      buffer += char;
      if (char === "\\" && index + 1 < line.length) {
        buffer += line[index + 1];
        index++;
        continue;
      }
      if (char === quote) {
        segments.push({ text: buffer, quoted: true });
        buffer = "";
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      if (buffer) {
        segments.push({ text: buffer, quoted: false });
        buffer = "";
      }
      buffer = char;
      quote = char;
      continue;
    }
    buffer += char;
  }
  if (buffer) {
    segments.push({ text: buffer, quoted: quote !== null });
  }

  const nodes: React.ReactNode[] = [];
  let key = 0;
  for (const segment of segments) {
    if (segment.quoted) {
      nodes.push(
        <span key={key++} className="text-ready">
          {segment.text}
        </span>
      );
      continue;
    }
    // A "// ..." comment only starts where the marker is preceded by
    // whitespace — never inside a URL such as https://…
    let commentIndex = -1;
    for (let index = 0; index < segment.text.length - 1; index++) {
      if (
        segment.text[index] === "/" &&
        segment.text[index + 1] === "/" &&
        (index === 0 || /\s/.test(segment.text[index - 1]))
      ) {
        commentIndex = index;
        break;
      }
    }
    const codeText =
      commentIndex === -1 ? segment.text : segment.text.slice(0, commentIndex);
    for (const word of codeText.split(/(\s+)/)) {
      if (!word) {
        continue;
      }
      const isWhitespace = /^\s+$/.test(word);
      const isKeyword = !isWhitespace && KEYWORDS.has(word.trim());
      nodes.push(
        <span key={key++} className={isKeyword ? "text-ember" : undefined}>
          {word}
        </span>
      );
    }
    if (commentIndex !== -1) {
      nodes.push(
        <span key={key++} className="text-muted-foreground">
          {segment.text.slice(commentIndex)}
        </span>
      );
    }
  }
  return nodes;
}

function CodeExamplePanel({
  title,
  badge,
  lines,
}: {
  title: string;
  badge: string;
  lines: string[];
}) {
  return (
    <div className="dash-panel flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border-soft bg-panel-strong/60 px-5 py-3.5">
        <h3 className="dash-section-title text-foreground">{title}</h3>
        <Badge variant="neutral" className="whitespace-nowrap">
          {badge}
        </Badge>
      </div>
      <pre className="dash-code flex-1 overflow-x-auto bg-background p-5 text-foreground/85">
        <code>
          {lines.map((line, index) => (
            <div key={index} className="whitespace-pre">
              {highlightLine(line)}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden pt-28 pb-12">
      {/* A single ember glow at the top of the charcoal page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[32rem]"
        style={{
          backgroundImage:
            "radial-gradient(ellipse at top, rgba(251, 146, 60, 0.10), transparent 65%)",
        }}
      />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-5xl px-6 text-center">
        <h1 className="text-4xl font-semibold leading-[1.12] tracking-tight sm:text-5xl md:text-6xl">
          Open-source video infrastructure.
          <br />
          <span className="text-ember">Bring your own keys.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-base text-muted-foreground sm:text-lg">
          Paste your Cloudflare R2 credentials and a Modal API key and get
          Mux-style HLS/DASH ingestion, transcoding, signed playback, and
          analytics — running on your own cloud account at your own cost.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {BADGES.map((badge) => (
            <Badge key={badge} variant="outline" className="px-3.5 py-1">
              {badge}
            </Badge>
          ))}
        </div>
        <p className="mx-auto mt-10 max-w-2xl text-[15px] text-muted-foreground">
          {APP_NAME} is Apache-2.0 and self-hostable — deploy the API, the
          delivery edge, and the transcoder yourself, then bring the cloud
          credentials you already have.
        </p>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <Navigation />
      <main>
        <Hero />

        {/* Deployment status */}
        <section className="border-t border-border-soft py-20 md:py-24">
          <div className="mx-auto max-w-5xl px-6">
            <div className="mb-10 text-center">
              <h2 className="text-3xl font-bold md:text-4xl">
                Deployment status
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-base text-muted-foreground">
                Live health checks against your local or self-hosted {APP_NAME}{" "}
                API. Everything below runs in your browser — nothing is fetched
                at build time.
              </p>
            </div>
            <ClusterHealth />
          </div>
        </section>

        {/* Quickstart */}
        <section className="border-t border-border-soft py-20 md:py-24">
          <div className="mx-auto max-w-6xl px-6">
            <div className="mb-10 text-center">
              <h2 className="text-3xl font-bold md:text-4xl">Quickstart</h2>
              <p className="mx-auto mt-3 max-w-2xl text-base text-muted-foreground">
                Create an upload token on your backend with your API key, then
                upload straight to R2 from the browser with the React SDK.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <CodeExamplePanel
                title="Server — request an upload token"
                badge="cURL · API key"
                lines={CURL_SNIPPET}
              />
              <CodeExamplePanel
                title="Client — upload from React"
                badge="React SDK"
                lines={REACT_SNIPPET}
              />
            </div>
            <p className="mx-auto mt-6 max-w-3xl text-center text-[15px] text-muted-foreground">
              Install with{" "}
              <code className="font-mono text-[14px] text-ember">
                npm install @clipmux/uploader @clipmux/player @clipmux/server
              </code>
              . Never expose your API key in the browser — the uploader takes a
              short-lived upload token instead.
            </p>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border-soft">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 py-10 text-[15px] text-muted-foreground sm:flex-row">
          <p className="flex items-center gap-2">
            <span className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
              {APP_NAME}
            </span>
            <span>— Apache-2.0</span>
          </p>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link
              href="/dashboard"
              className="transition-colors hover:text-ember"
            >
              Dashboard
            </Link>
            <a
              href={GITHUB_URL}
              className="transition-colors hover:text-ember"
            >
              GitHub
            </a>
            <Link href="/terms" className="transition-colors hover:text-ember">
              Terms
            </Link>
            <Link
              href="/privacy"
              className="transition-colors hover:text-ember"
            >
              Privacy
            </Link>
            <Link
              href="/cookies"
              className="transition-colors hover:text-ember"
            >
              Cookies
            </Link>
          </nav>
          <p className="text-[13px] text-muted-foreground">
            © {new Date().getFullYear()} {APP_NAME} contributors
          </p>
        </div>
      </footer>
    </>
  );
}
