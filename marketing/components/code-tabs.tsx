"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Clipboard } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

const codeSamples = {
  Upload: `import { createUploader } from "@openvod/uploader";

const session = await fetch("/api/upload-token", {
  method: "POST",
}).then((response) => response.json());

await createUploader({
  token: session.token,
}).upload(file);`,
  Play: `import { OpenVodPlayer } from "@openvod/player";

<OpenVodPlayer
  playbackId={video.id}
  src={video.playback_url}
  title={video.title}
  poster={video.poster_url}
/>`,
  "Verify webhook": `import { verifyWebhook } from "@openvod/server";

const event = await verifyWebhook(
  request,
  process.env.OPENVOD_WEBHOOK_SECRET,
);

if (event.type === "video.ready") {
  await publishVideo(event.data.video_id);
}`,
} as const;

type CodeTab = keyof typeof codeSamples;

export function CodeTabs() {
  const [active, setActive] = useState<CodeTab>("Upload");
  const [copied, setCopied] = useState(false);
  const reduceMotion = useReducedMotion();

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(codeSamples[active]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-window overflow-hidden rounded-2xl border border-white/10 bg-cinema shadow-2xl shadow-ink/10">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2 rounded-full bg-[#ff6b6b]" />
          <span className="size-2 rounded-full bg-[#ffd166]" />
          <span className="size-2 rounded-full bg-[#68d391]" />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">app/video.tsx</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet"
          onClick={copyCode}
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          {copied ? <Check className="size-3.5 text-[#bba3ff]" /> : <Clipboard className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex gap-1 border-b border-white/10 px-4 pt-3" role="tablist" aria-label="Code examples">
        {(Object.keys(codeSamples) as CodeTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active === tab}
            className={cn(
              "relative rounded-t-md px-3 py-2 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet",
              active === tab ? "text-white" : "text-white/40 hover:text-white/75",
            )}
            onClick={() => {
              setActive(tab);
              setCopied(false);
            }}
          >
            {tab}
            {active === tab ? <span className="absolute inset-x-2 bottom-0 h-px bg-violet" /> : null}
          </button>
        ))}
      </div>
      <div className="min-h-[330px] overflow-x-auto px-5 py-6 sm:min-h-[310px]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.pre
            key={active}
            className="font-mono text-[12px] leading-7 text-[#ddd4f8] sm:text-[13px]"
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
            role="tabpanel"
          >
            <code>{codeSamples[active]}</code>
          </motion.pre>
        </AnimatePresence>
      </div>
    </div>
  );
}
