"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check } from "lucide-react";

const tabs = [
    {
        id: "javascript",
        label: "JavaScript",
        code: `import { StreamFlow } from '@streamflow/sdk';

const client = new StreamFlow({
  apiKey: process.env.STREAMFLOW_API_KEY
});

// Upload and encode a video
const video = await client.videos.create({
  url: 'https://example.com/video.mp4',
  playbackPolicy: 'public'
});

console.log(video.playbackId);
// → "sf_abc123xyz"`,
    },
    {
        id: "python",
        label: "Python",
        code: `from streamflow import StreamFlow

client = StreamFlow(
    api_key=os.environ["STREAMFLOW_API_KEY"]
)

# Upload and encode a video
video = client.videos.create(
    url="https://example.com/video.mp4",
    playback_policy="public"
)

print(video.playback_id)
# → "sf_abc123xyz"`,
    },
    {
        id: "curl",
        label: "cURL",
        code: `curl -X POST https://api.streamflow.io/v1/videos \\
  -H "Authorization: Bearer $STREAMFLOW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com/video.mp4",
    "playback_policy": "public"
  }'

# Response:
# { "id": "vid_...", "playback_id": "sf_abc123xyz" }`,
    },
];

const endpoints = [
    { method: "POST", path: "/v1/videos", description: "Create a new video" },
    { method: "GET", path: "/v1/videos/:id", description: "Get video details" },
    { method: "DELETE", path: "/v1/videos/:id", description: "Delete a video" },
    { method: "GET", path: "/v1/videos/:id/playback", description: "Get playback URL" },
    { method: "POST", path: "/v1/live-streams", description: "Create live stream" },
    { method: "GET", path: "/v1/analytics", description: "Get analytics data" },
];

export function ApiShowcase() {
    const [activeTab, setActiveTab] = useState("javascript");
    const [copied, setCopied] = useState(false);

    const activeCode = tabs.find((t) => t.id === activeTab)?.code || "";

    const handleCopy = () => {
        navigator.clipboard.writeText(activeCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <section id="api" className="relative py-32 overflow-hidden">
            {/* Background */}
            <div className="absolute inset-0 bg-gradient-to-b from-background via-card/20 to-background" />
            <div className="absolute inset-0 grid-pattern opacity-20" />

            <div className="relative z-10 max-w-7xl mx-auto px-6">
                {/* Section Header */}
                <div className="text-center mb-16">
                    <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-6">
                        <span className="text-sm text-muted-foreground">
                            Built for developers
                        </span>
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold mb-4">
                        <span className="gradient-text">Simple API</span>, Powerful Results
                    </h2>
                    <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                        Integrate video encoding and streaming in minutes.
                        Clean REST endpoints, comprehensive SDKs, real-time webhooks.
                    </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Code Example */}
                    <div className="glass rounded-2xl overflow-hidden">
                        {/* Tabs */}
                        <div className="flex border-b border-border">
                            {tabs.map((tab) => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={cn(
                                        "px-6 py-3 text-sm font-medium transition-colors",
                                        activeTab === tab.id
                                            ? "text-foreground border-b-2 border-primary"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Code Block */}
                        <div className="relative">
                            <button
                                onClick={handleCopy}
                                className="absolute top-4 right-4 p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                aria-label="Copy code"
                            >
                                {copied ? (
                                    <Check className="w-4 h-4 text-success" />
                                ) : (
                                    <Copy className="w-4 h-4" />
                                )}
                            </button>
                            <pre className="p-6 overflow-x-auto">
                                <code className="text-sm font-mono text-muted-foreground">
                                    {activeCode.split("\n").map((line, i) => (
                                        <div key={i} className="leading-relaxed">
                                            {highlightSyntax(line)}
                                        </div>
                                    ))}
                                </code>
                            </pre>
                        </div>
                    </div>

                    {/* API Endpoints */}
                    <div className="glass rounded-2xl p-6">
                        <h3 className="text-lg font-semibold mb-6">REST API Endpoints</h3>
                        <div className="space-y-3">
                            {endpoints.map((endpoint, index) => (
                                <div
                                    key={index}
                                    className="flex items-center gap-4 p-3 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors group"
                                >
                                    <span
                                        className={cn(
                                            "px-2 py-1 rounded text-xs font-mono font-semibold",
                                            endpoint.method === "GET"
                                                ? "bg-accent/20 text-accent"
                                                : endpoint.method === "POST"
                                                    ? "bg-success/20 text-success"
                                                    : "bg-destructive/20 text-destructive"
                                        )}
                                    >
                                        {endpoint.method}
                                    </span>
                                    <code className="text-sm font-mono text-foreground flex-1">
                                        {endpoint.path}
                                    </code>
                                    <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                                        {endpoint.description}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <div className="mt-8 p-4 rounded-xl bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20">
                            <p className="text-sm text-muted-foreground">
                                <span className="text-foreground font-semibold">Full documentation</span>
                                {" "}with interactive examples, SDKs for 10+ languages, and webhooks.
                            </p>
                            <a
                                href="#"
                                className="inline-flex items-center gap-2 mt-3 text-sm text-primary hover:underline"
                            >
                                Explore the docs →
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

function highlightSyntax(line: string): React.ReactNode {
    // Simple syntax highlighting
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let key = 0;

    // Comments
    if (remaining.includes("//") || remaining.includes("#")) {
        const commentIndex = remaining.indexOf("//") !== -1
            ? remaining.indexOf("//")
            : remaining.indexOf("#");
        const before = remaining.slice(0, commentIndex);
        const comment = remaining.slice(commentIndex);
        parts.push(<span key={key++}>{highlightNonComment(before)}</span>);
        parts.push(
            <span key={key++} className="text-muted-foreground">
                {comment}
            </span>
        );
        return parts;
    }

    return highlightNonComment(line);
}

function highlightNonComment(text: string): React.ReactNode {
    // Highlight strings
    const stringPattern = /(["'`])(.*?)\1/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let key = 0;

    while ((match = stringPattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(
                <span key={key++}>
                    {highlightKeywords(text.slice(lastIndex, match.index))}
                </span>
            );
        }
        parts.push(
            <span key={key++} className="text-green-400">
                {match[0]}
            </span>
        );
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        parts.push(
            <span key={key++}>{highlightKeywords(text.slice(lastIndex))}</span>
        );
    }

    return parts.length > 0 ? parts : text;
}

function highlightKeywords(text: string): React.ReactNode {
    const keywords = [
        "import",
        "from",
        "const",
        "await",
        "async",
        "def",
        "print",
        "curl",
        "-X",
        "-H",
        "-d",
    ];
    let result = text;

    for (const keyword of keywords) {
        if (result.includes(keyword)) {
            const parts = result.split(keyword);
            return (
                <>
                    {parts.map((part, i) => (
                        <span key={i}>
                            {i > 0 && <span className="text-purple-400">{keyword}</span>}
                            {part}
                        </span>
                    ))}
                </>
            );
        }
    }

    return result;
}
