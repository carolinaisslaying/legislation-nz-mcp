/**
 * Convert a legislation document (HTML) into clean, readable plain text.
 *
 * This is the "Option A" approach: return the whole document as a text blob.
 * Structured, per-section XML parsing is a planned enhancement (see README
 * roadmap) and would live alongside this in a future version.
 */

import { parse } from "node-html-parser";

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
 *
 * The XML (unlike the `html` format, which is the full website page complete
 * with navigation) contains only the legislation content. We render provisions
 * with their section number and heading on one line, then the body, preserving
 * enough structure to read while staying a flat "Option A" text blob. Precise
 * per-section extraction from this same XML is a planned enhancement.
 */
// Tags that begin a new line. Deliberately excludes `heading` and `para`/`text`
// so a provision's number, heading, and text flow onto one line
// ("6 Interpretation ...") rather than being split across lines.
const XML_BLOCK_TAGS = new Set([
  "prov", "subprov", "label-para", "def-para", "item", "part", "subpart",
  "schedule", "cross-heading", "crosshead", "front", "enactment",
  "admin-office", "note", "history-note", "amending-provision", "leg-title",
]);

// Structural noise to remove entirely: the cover block (its title/date are
// returned as metadata), the auto-generated contents/TOC, and editorial notes.
const XML_DROP_TAGS = "cover, toc, contents, cover\\.reprint-note";

export function xmlToText(xml: string): string {
  // Strip the XML declaration / processing instructions before parsing.
  const cleaned = xml.replace(/<\?xml[^>]*\?>/gi, "");
  const root = parse(cleaned, { comment: false });

  root.querySelectorAll(XML_DROP_TAGS).forEach((el) => el.remove());

  root.querySelectorAll("*").forEach((el) => {
    const tag = el.rawTagName?.toLowerCase() ?? "";
    // A provision's label ("6") should sit inline before its heading ("6 Title").
    if (tag === "label") el.insertAdjacentHTML("afterend", " ");
    if (XML_BLOCK_TAGS.has(tag)) el.insertAdjacentHTML("beforebegin", "\n");
  });

  return normalizeWhitespace(root.textContent ?? "");
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
