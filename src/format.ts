/**
 * Convert legislation documents (HTML or XML) into clean, readable plain text.
 *
 * HTML conversion strips website chrome and returns a text blob.
 * XML conversion uses the shared rendering logic in xml.ts so whole-doc and
 * per-section extraction share the same output style.
 */

import { parse } from "node-html-parser";
import { parseLegislation, renderElementText } from "./xml.js";

/** Elements whose content is noise for reading the text of the law. */
const STRIP_TAGS = ["script", "style", "nav", "header", "footer", "head"];

/** Block-level tags that should produce a line break in the output. */
const BLOCK_TAGS = new Set([
  "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "article", "table", "blockquote",
]);

/**
 * Strip HTML to readable text, preserving paragraph/line breaks so that
 * sections and headings remain visually separated.
 */
export function htmlToText(html: string): string {
  const root = parse(html, {
    blockTextElements: { script: false, style: false, noscript: false },
  });

  for (const tag of STRIP_TAGS) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // Insert newline markers around block elements before extracting text.
  root.querySelectorAll("*").forEach((el) => {
    if (BLOCK_TAGS.has(el.rawTagName?.toLowerCase() ?? "")) {
      el.insertAdjacentHTML("afterend", "\n");
    }
  });

  const text = root.textContent ?? "";
  return normalizeWhitespace(text);
}

/** Collapse runs of blank lines / trailing spaces into a tidy document. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert the official legislation XML into readable plain text.
 * Delegates to renderElementText (src/xml.ts) after dropping structural noise
 * (cover block, TOC) so the whole-doc path shares rendering logic with
 * per-section extraction.
 */
export function xmlToText(xml: string): string {
  const root = parseLegislation(xml);
  // Drop the cover (title/date returned as metadata) and auto-generated TOC.
  root.querySelectorAll("cover, toc, contents, cover\\.reprint-note").forEach((el) => el.remove());
  return renderElementText(root);
}

/** Optionally truncate very large documents to protect the token budget. */
export function truncate(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + "\n\n[... truncated — document exceeds size limit ...]",
    truncated: true,
  };
}
