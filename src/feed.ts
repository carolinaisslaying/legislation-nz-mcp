/**
 * Parser for the legacy legislation.govt.nz feeds.
 *
 * Despite living under /api/rss/, the feeds are Atom 1.0. Each <entry> has a
 * website URL as its <id> and alternate <link>, a <title>, <published> and
 * <updated> timestamps, and an HTML <content> block of "Label: value" lines
 * (Title, Type, Subtype, Version, Year, Number). Probed live against the
 * search and versions feeds in September 2026.
 *
 * node-html-parser copes with the XML: the tags are unknown to it and become
 * generic elements, and <link .../> is a void element in HTML anyway.
 */

import { parse, type HTMLElement } from "node-html-parser";
import { isEphemeral } from "./util.js";

export interface FeedEntry {
  title: string;
  /** Website URL of the work or version. */
  url: string;
  /** Derived from the URL when it follows the legislation.govt.nz pattern. */
  work_id?: string;
  /** Present only when the URL names a specific version date. */
  version_id?: string;
  /** True when the URL uses the `latest` alias instead of a version date. */
  latest?: true;
  /** True when the derived id contains `~` and so may change later. */
  ephemeral?: true;
  published?: string;
  updated?: string;
  /** Fields from the entry's HTML content block. */
  type?: string;
  subtype?: string;
  version_label?: string;
  year?: string;
  number?: string;
}

export interface ParsedFeed {
  /** The feed's own <id>. The versions feed answers `not_found` for an unknown work. */
  feed_id: string;
  title: string;
  updated?: string;
  entries: FeedEntry[];
}

const LEGISLATION_TYPES = new Set(["act", "bill", "secondary-legislation", "amendment-paper"]);
const VERSION_DATE = /^~?\d{4}-\d{2}-\d{2}[A-Za-z]*$/;

/** First direct child element with the given tag name (not a descendant). */
function directChild(el: HTMLElement, tag: string): HTMLElement | undefined {
  return el.childNodes.find(
    (n) => (n as HTMLElement).rawTagName?.toLowerCase() === tag,
  ) as HTMLElement | undefined;
}

function directText(el: HTMLElement, tag: string): string | undefined {
  const text = directChild(el, tag)?.text.trim();
  return text ? text : undefined;
}

/**
 * Derive work_id / version_id from a legislation.govt.nz URL. Website URLs and
 * API identifiers share the same six segments:
 *   /{type}/{subtype}/{year}/{number}/{language}/{version_date}/
 */
export function idsFromUrl(url: string): Pick<FeedEntry, "work_id" | "version_id" | "latest"> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (!parsed.hostname.endsWith("legislation.govt.nz")) return {};
  const seg = parsed.pathname.split("/").filter(Boolean);
  if (seg.length < 4 || !LEGISLATION_TYPES.has(seg[0])) return {};
  const work_id = seg.slice(0, 4).join("_");
  const lang = seg[4];
  const versionDate = seg[5];
  if (!lang || !versionDate) return { work_id };
  if (versionDate === "latest") return { work_id, latest: true as const };
  if (VERSION_DATE.test(versionDate)) {
    return { work_id, version_id: `${work_id}_${lang}_${versionDate}` };
  }
  return { work_id };
}

/** Turn the entry's HTML content block into lower-cased label/value pairs. */
function parseContentFields(html: string): Record<string, string> {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  const text = parse(withBreaks).text;
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]*?):\s*(.*?)\s*$/);
    if (m && m[2]) fields[m[1].toLowerCase()] = m[2];
  }
  return fields;
}

/** Parse an Atom feed document into feed metadata and entries. */
export function parseFeed(xml: string): ParsedFeed {
  const root = parse(xml.replace(/<\?xml[^>]*\?>/gi, ""), { comment: false });
  const feed = root.querySelector("feed") ?? root;

  const entries: FeedEntry[] = feed.querySelectorAll("entry").map((entry) => {
    const link = entry.childNodes.find((n) => {
      const el = n as HTMLElement;
      return (
        el.rawTagName?.toLowerCase() === "link" &&
        (el.getAttribute("rel") ?? "alternate") === "alternate"
      );
    }) as HTMLElement | undefined;
    const url = link?.getAttribute("href") ?? directText(entry, "id") ?? "";
    // The <content> text is entity-escaped HTML; .text decodes it to markup.
    const fields = parseContentFields(directChild(entry, "content")?.text ?? "");
    const ids = idsFromUrl(url);
    return {
      title: directText(entry, "title") ?? fields.title ?? "",
      url,
      ...ids,
      ephemeral: isEphemeral(ids.version_id ?? ids.work_id),
      published: directText(entry, "published"),
      updated: directText(entry, "updated"),
      type: fields.type,
      subtype: fields.subtype,
      version_label: fields.version,
      year: fields.year,
      number: fields.number,
    };
  });

  return {
    feed_id: directText(feed, "id") ?? "",
    title: directText(feed, "title") ?? "",
    updated: directText(feed, "updated"),
    entries,
  };
}
