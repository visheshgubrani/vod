"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CodeBlock } from "@/components/code-block";
import type { CodeExample } from "@/lib/code-samples";

/**
 * The page's one code surface: a filename, the surface the code runs on, a copy
 * control, and syntax-highlighted text.
 *
 * Every code sample on the page renders through this component, so two samples
 * can never drift into two different sizes, palettes, or chrome. The body
 * scrolls horizontally rather than shrinking its text.
 */
export function CodePanel({ example }: { example: CodeExample }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(example.code);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-panel">
      <div className="code-panel-bar">
        <span className="code-panel-file">
          <strong>{example.file}</strong>
          <span className="code-panel-scope">{example.surface}</span>
        </span>
        <button
          type="button"
          className="code-copy"
          onClick={copy}
          aria-label={copied ? "Code copied" : "Copy this example"}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="code-body">
        <CodeBlock code={example.code} label={example.file} />
      </div>
    </div>
  );
}
