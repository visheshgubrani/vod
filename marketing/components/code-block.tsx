import type { ReactNode } from "react";

/**
 * A very small tokenizer for the languages this page shows — TypeScript,
 * TSX, JSON, and shell.
 *
 * It is deliberately not a parser: a landing page needs comments, strings,
 * keywords, JSX tags and function calls to be visually distinct, and a real
 * grammar would add a dependency and a bundle for no extra clarity. Unknown
 * text falls through as plain.
 */
type TokenKind = "plain" | "comment" | "string" | "keyword" | "tag" | "fn";

type Token = { text: string; kind: TokenKind };

const KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "const",
  "let",
  "await",
  "async",
  "new",
  "return",
  "function",
  "if",
  "else",
  "type",
  "true",
  "false",
  "null",
  "undefined",
]);

const TAG_PATTERN = /^<\/?[A-Z][A-Za-z0-9.]*/;
const CALL_PATTERN = /^[A-Za-z_$][\w$]*(?=\()/;

export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = () => {
    if (!plain) return;
    // Split the accumulated plain run into words so keywords, tags and calls
    // can be classified without losing the original whitespace.
    for (const part of plain.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        tokens.push({ text: part, kind: "plain" });
        continue;
      }

      const tag = TAG_PATTERN.exec(part);
      if (tag) {
        tokens.push({ text: tag[0], kind: "tag" });
        tokens.push({ text: part.slice(tag[0].length), kind: "plain" });
        continue;
      }

      if (KEYWORDS.has(part)) {
        tokens.push({ text: part, kind: "keyword" });
        continue;
      }

      const call = CALL_PATTERN.exec(part);
      if (call) {
        tokens.push({ text: call[0], kind: "fn" });
        tokens.push({ text: part.slice(call[0].length), kind: "plain" });
        continue;
      }

      tokens.push({ text: part, kind: "plain" });
    }
    plain = "";
  };

  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];

    // Line comments: `//` anywhere, `#` only where a command would start.
    const startsShellComment =
      char === "#" && (index === 0 || /[\s;]/.test(code[index - 1]));
    if ((char === "/" && next === "/") || startsShellComment) {
      flushPlain();
      const end = code.indexOf("\n", index);
      const stop = end === -1 ? code.length : end;
      tokens.push({ text: code.slice(index, stop), kind: "comment" });
      index = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      flushPlain();
      let cursor = index + 1;
      while (cursor < code.length) {
        if (code[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (code[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      tokens.push({ text: code.slice(index, cursor), kind: "string" });
      index = cursor;
      continue;
    }

    plain += char;
    index += 1;
  }

  flushPlain();
  return tokens;
}

const KIND_CLASS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: "tok-comment",
  string: "tok-string",
  keyword: "tok-keyword",
  tag: "tok-tag",
  fn: "tok-fn",
};

/**
 * Renders a code sample with the shared token colours. Text stays selectable —
 * this is a `<pre><code>` block, not an image or a canvas.
 */
export function CodeBlock({
  code,
  label,
  className,
}: {
  code: string;
  label?: string;
  className?: string;
}): ReactNode {
  return (
    <pre className={className} aria-label={label}>
      <code>
        {tokenize(code).map((token, tokenIndex) => {
          const kindClass = KIND_CLASS[token.kind];
          return kindClass ? (
            <span key={tokenIndex} className={kindClass}>
              {token.text}
            </span>
          ) : (
            <span key={tokenIndex}>{token.text}</span>
          );
        })}
      </code>
    </pre>
  );
}
