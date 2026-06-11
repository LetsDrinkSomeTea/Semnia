import React from "react";
import type { SearchResult } from "../types";

export function extractCitedNums(text: string): Set<number> {
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[#?([\d,\s#]+)\]/g))
    m[1]
      .split(/[,\s#]+/)
      .map(Number)
      .filter(Boolean)
      .forEach((n) => cited.add(n));
  return cited;
}

export function renderWithCitations(
  text: string,
  sources: SearchResult[],
  onCite: (id: number) => void,
): React.ReactNode[] {
  const parts = text.split(/(\[#?\d+(?:[,\s#]*#?\d+)*\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[#?([\d,\s#]+)\]$/);
    if (!match) return part;
    const nums = match[1]
      .split(/[,\s#]+/)
      .map(Number)
      .filter((n) => n >= 1);

    if (!nums.length) return part;
    return (
      <span key={i} className="llm-citations">
        {nums.map((n) => {
          // If sources are provided, n is 1-indexed and maps to sources[n-1].id
          // If sources is empty (Agentic mode), n is already the direct ID
          const src = sources.length > 0 ? sources[n - 1] : undefined;
          const targetId = sources.length > 0 ? (src ? src.id : null) : n;

          if (targetId === null) return null;

          return (
            <button
              key={n}
              className="llm-citation"
              title={src?.display_title || `Dokument ${targetId}`}
              onClick={() => onCite(targetId)}
            >
              {n}
            </button>
          );
        })}
      </span>
    );
  });
}

export function computeSpans(text: string, words: string[]): number[][] {
  const spans: number[][] = [];
  const low = text.toLowerCase();
  for (const w of words) {
    let pos = 0;
    while (true) {
      const idx = low.indexOf(w, pos);
      if (idx === -1) break;
      spans.push([idx, idx + w.length]);
      pos = idx + 1;
    }
  }
  return spans;
}

export function renderHighlighted(
  text: string,
  spans: number[][],
): React.ReactNode {
  if (!spans || !spans.length) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  for (const [s, e] of sorted) {
    if (s > cursor) parts.push(text.slice(cursor, s));
    parts.push(<mark key={s}>{text.slice(s, e)}</mark>);
    cursor = e;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function renderSnippet(
  snippet: string,
  spans: number[][],
): React.ReactNode {
  return renderHighlighted(snippet, spans);
}

export function findChunkRange(
  text: string,
  snippet: string,
): [number, number] | null {
  const inner = snippet.replace(/^…/, "").replace(/…$/, "");
  if (inner.length < 5) return null;
  const idx = text.indexOf(inner);
  if (idx === -1) return null;
  return [idx, idx + inner.length];
}

export function renderWithChunkHighlight(
  text: string,
  snippet: string,
  firstMarkRef: React.MutableRefObject<Element | null>,
): React.ReactNode {
  const range = findChunkRange(text, snippet);
  if (!range) return text;
  const [s, e] = range;
  return (
    <>
      {s > 0 && text.slice(0, s)}
      <mark
        ref={(el) => {
          firstMarkRef.current = el;
        }}
      >
        {text.slice(s, e)}
      </mark>
      {e < text.length && text.slice(e)}
    </>
  );
}
