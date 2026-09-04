import Link from "next/link";
import { Navigation } from "@/components/navigation";
import { ClusterHealth } from "@/components/dashboard/cluster-health";
import { APP_NAME, GITHUB_URL } from "@/lib/site";

const BADGES = ["HLS + DASH", "Cloudflare R2", "Modal GPU", "Apache-2.0"];

// Pseudo-curl example — endpoints are illustrative and vary per deployment.
const CURL_SNIPPET = [
  "# Example — pseudo-curl; adjust the host to your deployment",
  "# 1. Create an upload token with your API key",
  'curl -X POST https://api.example.com/api/v1/upload/token \\',
  '  -H "Authorization: Bearer $OPENVOD_API_KEY" \\',
  '  -d \'{ "expires_in": "1h" }\'',
  "",
  "# 2. Upload via the SDK",
];

// Illustrative — @openvod/uploader is not published yet.
const REACT_SNIPPET = [
  '// Illustrative — @openvod/uploader is not published yet',
  'import { Uploader } from "@openvod/uploader";',
  "",
  "const uploader = new Uploader({",
  '  baseUrl: "https://api.example.com/api",',
  "  uploadToken, // created by your backend in step 1",
  "});",
  "",
  "await uploader.upload(file, {",
  '  title: "My first video",',
  '  onProgress: ({ percentage }) => console.log(percentage + "%"),',
  "});",
];

const KEYWORDS = new Set(["curl", "import", "from", "const", "new", "await"]);

function highlightLine(line: string): React.ReactNode {
  if (/^\s*(#|\/\/)/.test(line)) {
    return <span className="text-muted-foreground/80">{line}</span>;
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
        <span key={key++} className="text-lime-400">
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
        <span key={key++} className={isKeyword ? "text-purple-300" : undefined}>
          {word}
        </span>
      );
    }
    if (commentIndex !== -1) {
      nodes.push(
        <span key={key++} className="text-muted-foreground/80">
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
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card/55 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="whitespace-nowrap rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {badge}
        </span>
      </div>
      <pre className="flex-1 overflow-x-auto bg-muted/20 p-5 font-mono text-[0.8125rem] leading-6 text-foreground/85">
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
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-card/25 to-background" />
      <div className="absolute inset-0 grid-pattern opacity-65" />
      <div className="absolute inset-0 radial-overlay" />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-5xl px-6 text-center">
        <h1 className="animate-fade-in-up text-4xl font-semibold leading-[1.12] tracking-tight sm:text-5xl md:text-6xl">
          Open-source video infrastructure.
          <br />
          <span className="gradient-text">Bring your own keys.</span>
        </h1>
        <p
          className="mx-auto mt-6 max-w-3xl animate-fade-in-up text-base text-white/70 sm:text-lg"
          style={{ animationDelay: "0.15s" }}
        >
          Paste your Cloudflare R2 credentials and a Modal API key and get
          Mux-style HLS/DASH ingestion, transcoding, signed playback, and
          analytics — running on your own cloud account at your own cost.
        </p>
        <div
          className="mt-8 flex animate-fade-in-up flex-wrap items-center justify-center gap-3"
          style={{ animationDelay: "0.25s" }}
        >
          {BADGES.map((badge) => (
            <span key={badge} className="landing-badge landing-badge-md">
              {badge}
            </span>
          ))}
        </div>
        <p
          className="mx-auto mt-10 max-w-2xl animate-fade-in-up text-sm text-muted-foreground"
          style={{ animationDelay: "0.35s" }}
        >
          {APP_NAME} is Apache-2.0 and self-hostable — deploy the API, the
          delivery edge, and the transcoder yourself, then bring the cloud
          credentials you already have.
        </p>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
}

export default function Home() {
  return (
    <>
      <Navigation />
      <main className="landing-page">
        <Hero />

        {/* Deployment status */}
        <section className="relative overflow-hidden py-20 md:py-24">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-card/15 to-background" />
          <div className="relative z-10 mx-auto max-w-5xl px-6">
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
        <section className="relative overflow-hidden py-20 md:py-24">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-card/10 to-background" />
          <div className="relative z-10 mx-auto max-w-6xl px-6">
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
                badge="cURL · example"
                lines={CURL_SNIPPET}
              />
              <CodeExamplePanel
                title="Client — upload from React"
                badge="React SDK · illustrative"
                lines={REACT_SNIPPET}
              />
            </div>
            <p className="mx-auto mt-6 max-w-3xl text-center text-xs text-muted-foreground">
              Endpoints and package names above are illustrative until the
              OpenVOD API and @openvod packages are published. Never expose
              your API key in the browser — the SDK takes a short-lived upload
              token instead.
            </p>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/70">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-muted-foreground sm:flex-row">
          <p className="flex items-center gap-2">
            <span className="font-dashboard-heading text-lg font-semibold tracking-wider text-foreground">
              {APP_NAME}
            </span>
            <span>— Apache-2.0</span>
          </p>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link href="/dashboard" className="transition-colors hover:text-foreground">
              Dashboard
            </Link>
            <a href={GITHUB_URL} className="transition-colors hover:text-foreground">
              GitHub
            </a>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/cookies" className="transition-colors hover:text-foreground">
              Cookies
            </Link>
          </nav>
          <p className="text-xs text-muted-foreground/70">
            © {new Date().getFullYear()} {APP_NAME} contributors
          </p>
        </div>
      </footer>
    </>
  );
}
