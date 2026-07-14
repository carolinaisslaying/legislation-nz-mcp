/**
 * XML navigation for NZ legislation documents.
 *
 * The official XML format (not the `html` format, which is the full website
 * page) contains the legislation content structured with elements like:
 *   <body>         — main provisions
 *     <part>       — Part (label + heading)
 *       <subpart>  — Subpart (label + heading)
 *         <prov>   — Section (label + heading + prov.body)
 *   <schedule.group>
 *     <schedule>   — Schedule (label + heading + schedule.provisions)
 *
 * Probed live against the Privacy Act 2020. node-html-parser handles the XML
 * without issues (dotted tag names like prov.body are opaque to it).
 */

import { parse, type HTMLElement } from "node-html-parser";
import { normalizeWhitespace } from "./format.js";

// Block-level XML elements that should produce a line break in rendered text.
const XML_BLOCK_TAGS = new Set([
  "prov", "subprov", "label-para", "def-para", "item", "part", "subpart",
  "schedule", "cross-heading", "crosshead", "front", "enactment",
  "admin-office", "note", "history-note", "amending-provision", "leg-title",
  "schedule.provisions", "schedule.misc",
]);

// Elements to strip entirely before rendering (noise, not legislation text).
const XML_DROP_SELECTOR = "cover, toc, contents, cover\\.reprint-note, cf, notes";

export interface SectionResult {
  number: string;
  heading: string;
  part?: string;
  subpart?: string;
  text: string;
}

export interface ScheduleResult {
  number: string;
  heading: string;
  text: string;
}

export interface SectionSummary {
  number: string;
  heading: string;
}

export interface SubpartSummary {
  label: string;
  heading: string;
  sections: SectionSummary[];
}

export interface PartSummary {
  label: string;
  heading: string;
  subparts: SubpartSummary[];
  sections: SectionSummary[]; // sections directly under this part (no subpart)
}

export interface DocumentStructure {
  ungroupedSections: SectionSummary[]; // sections in <body> before any <part>
  parts: PartSummary[];
  schedules: SectionSummary[];
}

/** Parse the raw XML string into a navigable tree. */
export function parseLegislation(xml: string): HTMLElement {
  const cleaned = xml.replace(/<\?xml[^>]*\?>/gi, "");
  return parse(cleaned, { comment: false });
}

/**
 * Render an element's text content with basic structure: block tags get a
 * leading newline, labels get a trailing space (so "6 Heading" stays on one
 * line), and noise elements are dropped before rendering.
 */
export function renderElementText(el: HTMLElement): string {
  // Clone by re-parsing the outer HTML so we don't mutate the shared tree.
  const copy = parse(el.outerHTML, { comment: false }).firstChild as HTMLElement;
  copy.querySelectorAll(XML_DROP_SELECTOR).forEach((n) => n.remove());
  copy.querySelectorAll("*").forEach((n) => {
    const tag = n.rawTagName?.toLowerCase() ?? "";
    if (tag === "label") n.insertAdjacentHTML("afterend", " ");
    if (XML_BLOCK_TAGS.has(tag)) n.insertAdjacentHTML("beforebegin", "\n");
  });
  return normalizeWhitespace(copy.textContent ?? "");
}

/** Return the direct `<label>` text of a prov/part/subpart/schedule element. */
function directLabel(el: HTMLElement): string {
  // querySelector finds the *first* label anywhere in the subtree. For a
  // <prov> with many nested subsection labels, the first child label is the
  // section number — but we want only the direct child, not a descendant.
  const child = el.childNodes.find(
    (n) => (n as HTMLElement).rawTagName?.toLowerCase() === "label",
  ) as HTMLElement | undefined;
  return child?.textContent?.trim() ?? "";
}

/** Return the direct `<heading>` text of an element. */
function directHeading(el: HTMLElement): string {
  const child = el.childNodes.find(
    (n) => (n as HTMLElement).rawTagName?.toLowerCase() === "heading",
  ) as HTMLElement | undefined;
  return child?.textContent?.trim() ?? "";
}

/**
 * Walk up the parent chain from a <prov> and collect the nearest enclosing
 * part and subpart labels/headings.
 */
function ancestorContext(prov: HTMLElement): { part?: string; subpart?: string } {
  let part: string | undefined;
  let subpart: string | undefined;
  let node = prov.parentNode as HTMLElement | null;
  while (node) {
    const tag = node.rawTagName?.toLowerCase();
    if (tag === "subpart" && !subpart) {
      const lbl = directLabel(node);
      const hd = directHeading(node);
      subpart = [lbl && `Subpart ${lbl}`, hd].filter(Boolean).join(" — ");
    }
    if (tag === "part" && !part) {
      const lbl = directLabel(node);
      const hd = directHeading(node);
      part = [lbl && `Part ${lbl}`, hd].filter(Boolean).join(" — ");
    }
    node = node.parentNode as HTMLElement | null;
  }
  return { part, subpart };
}

/**
 * Find a section (provision) by number within the main <body>.
 * Scoped to <body> so schedule/amendment provisions with duplicate numbers
 * are not matched.
 */
export function findSection(root: HTMLElement, id: string): SectionResult | null {
  const body = root.querySelector("body");
  if (!body) return null;
  const normalised = id.trim();
  const provs = body.querySelectorAll("prov");
  const prov = provs.find((p) => directLabel(p) === normalised);
  if (!prov) return null;
  const { part, subpart } = ancestorContext(prov);
  return {
    number: normalised,
    heading: directHeading(prov),
    part,
    subpart,
    text: renderElementText(prov),
  };
}

/**
 * Find a schedule by number.
 * Schedules live under <schedule.group>, separate from <body>.
 */
export function findSchedule(root: HTMLElement, id: string): ScheduleResult | null {
  const normalised = id.trim();
  const schedules = root.querySelectorAll("schedule");
  const sched = schedules.find((s) => directLabel(s) === normalised);
  if (!sched) return null;
  return {
    number: normalised,
    heading: directHeading(sched),
    text: renderElementText(sched),
  };
}

/**
 * Build a table-of-contents structure for the document: parts (with their
 * subparts and sections), any top-level sections not inside a part, and
 * schedules.
 */
export function buildStructure(root: HTMLElement): DocumentStructure {
  const body = root.querySelector("body");
  const ungroupedSections: SectionSummary[] = [];
  const parts: PartSummary[] = [];

  if (body) {
    // Walk direct children of body to preserve order.
    for (const child of body.childNodes) {
      const el = child as HTMLElement;
      const tag = el.rawTagName?.toLowerCase();
      if (tag === "prov") {
        ungroupedSections.push({ number: directLabel(el), heading: directHeading(el) });
      } else if (tag === "part") {
        const partEntry: PartSummary = {
          label: directLabel(el),
          heading: directHeading(el),
          subparts: [],
          sections: [],
        };
        for (const partChild of el.childNodes) {
          const pc = partChild as HTMLElement;
          const ptag = pc.rawTagName?.toLowerCase();
          if (ptag === "prov") {
            partEntry.sections.push({ number: directLabel(pc), heading: directHeading(pc) });
          } else if (ptag === "subpart") {
            const subpartEntry: SubpartSummary = {
              label: directLabel(pc),
              heading: directHeading(pc),
              sections: [],
            };
            for (const spChild of pc.childNodes) {
              const sc = spChild as HTMLElement;
              if (sc.rawTagName?.toLowerCase() === "prov") {
                subpartEntry.sections.push({ number: directLabel(sc), heading: directHeading(sc) });
              }
            }
            partEntry.subparts.push(subpartEntry);
          }
        }
        parts.push(partEntry);
      }
    }
  }

  const schedules: SectionSummary[] = root
    .querySelectorAll("schedule")
    .map((s) => ({ number: directLabel(s), heading: directHeading(s) }));

  return { ungroupedSections, parts, schedules };
}
