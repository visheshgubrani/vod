"use client";

import { Check, Copy, Play } from "lucide-react";
import { useState } from "react";

import { CodeBlock } from "@/components/code-block";
import { codeTabs, playerPreviewThumb, type CodeTabId } from "@/lib/code-samples";

function ResultPanel({ tab }: { tab: (typeof codeTabs)[number] }) {
  return (
    <div className="result-panel">
      <div className="result-panel-head">{tab.resultTitle}</div>
      <div className="result-panel-body">
        {tab.progress ? (
          <>
            <div className="process-track">
              <span style={{ width: `${tab.progress.percentage}%` }} />
            </div>
            <div className="mt-3 flex items-center justify-between font-mono text-[13px] text-[color:var(--muted)]">
              <span>Uploading</span>
              <span>
                part {tab.progress.partsCompleted}/{tab.progress.partsTotal} ·{" "}
                {tab.progress.percentage}%
              </span>
            </div>
          </>
        ) : tab.player ? (
          <div className="media-frame">
            <img
              src={playerPreviewThumb}
              alt=""
              width={1280}
              height={720}
              loading="lazy"
              decoding="async"
            />
            <div className="media-scrim">
              <span className="media-button media-button--primary">
                <Play
                  className="ml-0.5 size-4 fill-current"
                  aria-hidden="true"
                />
              </span>
              <p className="media-caption">coastal-headland · 00:42</p>
            </div>
          </div>
        ) : (
          <dl>
            {tab.rows?.map((row) => (
              <div key={row.label} className="result-row">
                <dt className="font-mono text-[13px]">{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <p className="example-note">{tab.note}</p>
      </div>
    </div>
  );
}

/**
 * Four accessible tabs. Each shows a real filename, whether the code runs on
 * the server or in the browser, selectable code with copy feedback, and the
 * result that code produces.
 */
export function CodeTabs() {
  const [active, setActive] = useState<CodeTabId>("token");
  const [copied, setCopied] = useState<CodeTabId | null>(null);

  const activeTab = codeTabs.find((tab) => tab.id === active) ?? codeTabs[0];

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(activeTab.code);
      setCopied(activeTab.id);
      window.setTimeout(
        () => setCopied((current) => (current === activeTab.id ? null : current)),
        1800,
      );
    } catch {
      setCopied(null);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;

    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const currentIndex = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    if (currentIndex === -1) return;

    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + buttons.length) % buttons.length
            : (currentIndex + 1) % buttons.length;

    buttons[nextIndex]?.focus();
    setActive(codeTabs[nextIndex].id);
  };

  return (
    <div className="integrate-grid">
      <div className="code-panel">
        <div className="code-panel-bar">
          <span className="code-panel-file">
            <strong>{activeTab.file}</strong>
            <span className="code-panel-scope">{activeTab.scope}</span>
          </span>
          <button
            type="button"
            className="code-copy"
            onClick={copyCode}
            aria-label={
              copied === activeTab.id ? "Code copied" : "Copy this example"
            }
          >
            {copied === activeTab.id ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied === activeTab.id ? "Copied" : "Copy"}
          </button>
        </div>

        <div
          className="code-tabs"
          role="tablist"
          aria-label="Integration steps"
          onKeyDown={onKeyDown}
        >
          {codeTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`integration-tab-${tab.id}`}
              aria-selected={active === tab.id}
              aria-controls={`integration-panel-${tab.id}`}
              tabIndex={active === tab.id ? 0 : -1}
              className="code-tab"
              onClick={() => {
                setActive(tab.id);
                setCopied(null);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          className="code-body"
          role="tabpanel"
          id={`integration-panel-${activeTab.id}`}
          aria-labelledby={`integration-tab-${activeTab.id}`}
          tabIndex={0}
        >
          <CodeBlock code={activeTab.code} label={activeTab.file} />
        </div>
      </div>

      <ResultPanel tab={activeTab} />
    </div>
  );
}
