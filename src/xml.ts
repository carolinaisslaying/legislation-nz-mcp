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

import { parse, NodeType, type HTMLElement, type Node, type TextNode } from "node-html-parser";
import { normalizeWhitespace } from "./format.js";

// Block-level XML elements that should produce a line break in rendered text.
const XML_BLOCK_TAGS = new Set([
  "prov", "subprov", "label-para", "def-para", "item", "part", "subpart",
  "schedule", "cross-heading", "crosshead", "front", "enactment",
  "admin-office", "note", "history-note", "amending-provision", "leg-title",
  "schedule.provisions", "schedule.misc",
]);

// Block-level elements whose text must not share a line with the text next to
// them ("Regulations 2026Cindy Kiro, Governor-General"). Unlike XML_BLOCK_TAGS
// they only add a line break where the source doesn't already have one. Tags
// not listed here or in XML_SEPARATORS (emphasis, citation, def-term,
// subscript, ...) are inline and never get a separator.
const XML_LINE_TAGS = [
  // cover, front and end matter
  "cover", "title", "title.former", "assent", "commencement", "reprint-date",
  "cover.reprint-note", "gg", "made", "made.at", "made.present", "billdetail",
  "billtype", "member", "repnote", "key", "subheading", "commentary",
  "comm.appendix", "comm.lev1", "comm.lev2", "comm.lev3", "long-title",
  "pursuant", "preamble", "preamble-block", "preamble.headlev2",
  "preamble.headlev3", "motion", "body", "end", "end.reprint-note",
  "reprint.index", "reprint.notes", "reprint.note", "reprint.amend",
  "promulgation", "issue-authority", "gazette-date", "signature-block",
  "sig.officer", "sig.para", "explnote", "explnote.group", "explnote.part",
  "explnote.subpart", "explnote.crosshead", "explnote.subhead1",
  "explnote.subhead2", "clause.desc", "leg-history", "history-item",
  "skeletons", "skeleton.act", "skeleton.act.cover", "skeleton.act.front",
  "skeleton.act.body", "skeleton.reg", "skeleton.reg.cover",
  "skeleton.reg.front", "skeleton.reg.body", "skeleton.reg.end",
  // bills and supplementary order papers
  "bill", "bill.sop.body", "billref", "sop.amend", "sop.para", "clause.ref",
  "instrument.amend",
  // provisions
  "heading", "prov.body", "para", "text", "proviso", "list", "amend",
  "example", "eqn", "eqn-line", "variable-def", "label-para.crosshead",
  "subprov.crosshead", "notes", "history", "editorial-note", "cf",
  "amends-note", "amends-text", "graphic-text",
  // schedules, forms and conventions
  "schedule.group", "schedule.forms", "form", "form.body", "authorisation",
  "head1", "head2", "head3", "head4", "head5", "head6",
  "schedule.amendments", "schedule.amendments.group1",
  "schedule.amendments.group2", "conv", "conv.front", "conv.body", "conv.end",
  // tables
  "legtable", "summary", "table", "tgroup", "thead", "tbody", "row",
];

// Separator each element needs from the neighbouring text: a line break
// between blocks, " | " between table cells. " " and "/" apply only where the
// element starts, or sits between the two texts (empty brk, field, leader).
// XML_BLOCK_TAGS are listed too, for table cells, where renderElementText
// doesn't insert their line breaks (leg-title and amending-provision sit
// inline in citations and history notes, so they are left out).
const XML_SEPARATORS = new Map<string, string>([
  ...XML_LINE_TAGS.map((tag): [string, string] => [tag, "\n"]),
  ...[...XML_BLOCK_TAGS]
    .filter((tag) => tag !== "leg-title" && tag !== "amending-provision")
    .map((tag): [string, string] => [tag, "\n"]),
  ["brk", "\n"],
  ["entry", " | "],
  ["description", " "], ["amends-affect", " "], ["date", " "],
  ["fraction", " "], ["field", " "], ["leader", " "],
  ["denominator", "/"],
]);

// When several elements meet at the same depth of a boundary, the strongest
// separator wins.
const SEPARATOR_STRENGTH = ["/", " ", " | ", "\n"];

// Elements followed by a space so the next text stays on the same line:
// "299 Purpose of register", "a to enable ...", "2 r 194 Fees for ...".
const XML_SPACE_AFTER_TAGS = new Set(["label", "term", "variable", "empowering-prov"]);

const TABLE_PARTS = new Set(["table", "tgroup", "thead", "tbody", "tfoot", "row", "entry"]);

/**
 * Content types that can be excluded from rendered output.
 * Pass an array of these to renderElementText / findSection / findSchedule /
 * xmlToText. By default (empty array) all content is kept.
 */
export type ExcludeOption =
  | "cover"
  | "history_notes"
  | "comparative_references"
  | "editorial_notes"
  | "defined_term_links"
  | "end_matter";

const EXCLUDE_SELECTORS: Record<ExcludeOption, string> = {
  cover: "cover, cover\\.reprint-note",
  history_notes: "history-note",
  comparative_references: "cf",
  editorial_notes: "editorial-note, amends-note",
  defined_term_links: "ird\\.aids",
  end_matter: "end\\.reprint-note, leg-history",
};

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
 * line). toc/contents are always dropped (list_sections covers them better).
 * Pass `exclude` to additionally strip specific content types.
 */
export function renderElementText(el: HTMLElement, exclude: ExcludeOption[] = []): string {
  // Clone by re-parsing the outer HTML so we don't mutate the shared tree.
  // Take the first element rather than firstChild: when el is the document
  // root, some PCO files have a newline after the <?xml?> declaration, so the
  // first child is a whitespace text node.
  const copy = parse(el.outerHTML, { comment: false }).childNodes.find(
    (n) => n.nodeType === NodeType.ELEMENT_NODE,
  ) as HTMLElement;
  // Always drop auto-generated navigation — list_sections provides this better.
  copy.querySelectorAll("toc, contents").forEach((n) => n.remove());
  for (const opt of exclude) {
    copy.querySelectorAll(EXCLUDE_SELECTORS[opt]).forEach((n) => n.remove());
  }
  const marked: [HTMLElement, string][] = [];
  // The element itself may be struck out, or sit inside struck-out text.
  const struckOut = hasStruckOutAncestor(el);
  if (struckOut) marked.push([copy, "deleted"]);
  else if (tagOf(copy) === "footnote") marked.push([copy, "footnote"]);
  copy.querySelectorAll("*").forEach((n) => {
    const tag = tagOf(n);
    // label: trailing space so "6 Heading" renders on one line.
    // term: trailing space so ITA defined-term lists don't mash together.
    // variable, empowering-prov: "a is the claimant's earnings", "2 r 194 Fees".
    if (XML_SPACE_AFTER_TAGS.has(tag)) n.insertAdjacentHTML("afterend", " ");
    // Inside a table cell, a footnote or struck-out words, separateAdjacentText
    // decides instead, so table rows stay on one line and marked text inline.
    if (XML_BLOCK_TAGS.has(tag) && !insideCellOrMarkedWords(n.parentNode)) {
      n.insertAdjacentHTML("beforebegin", "\n");
    }
    const marker = markerFor(n);
    // Of nested struck-out elements, only the outermost is marked.
    if (marker && !(marker === "deleted" && (struckOut || hasStruckOutAncestor(n.parentNode)))) {
      marked.push([n, marker]);
    }
  });
  // Innermost first, so that markers nest properly. Keep the text each
  // marked node had before, for decisions about the source text.
  const sourceText = new Map<TextNode, string>();
  for (const [n, marker] of [...marked].reverse()) markInline(n, marker, sourceText);
  prepareCellText(copy, false);
  separateAdjacentText(copy, new Set(marked.map(([n]) => n)), sourceText);
  return normalizeWhitespace(copy.textContent ?? "");
}

/**
 * Text rendered with a marker around it, setting it apart from the text
 * around it: footnotes, and words or whole provisions struck out of a bill
 * (<struckoutwords>, or amend.level1="struckout-..." on a block element).
 */
function markerFor(el: HTMLElement): string | undefined {
  if (tagOf(el) === "footnote") return "footnote";
  if (isStruckOut(el)) return "deleted";
  return undefined;
}

function isStruckOut(el: HTMLElement): boolean {
  // node-html-parser splits dotted attribute names, so read the raw attributes.
  return tagOf(el) === "struckoutwords" || /\bamend\.level\d+=["']struckout/.test(el.rawAttrs);
}

function hasStruckOutAncestor(el: HTMLElement | null): boolean {
  for (let n = el; n; n = n.parentNode) if (isStruckOut(n)) return true;
  return false;
}

function insideCellOrMarkedWords(el: HTMLElement | null): boolean {
  for (let n = el; n; n = n.parentNode) {
    const tag = tagOf(n);
    if (tag === "entry" || tag === "footnote" || tag === "struckoutwords") return true;
  }
  return false;
}

function tagOf(el: HTMLElement | null | undefined): string {
  return el?.rawTagName?.toLowerCase() ?? "";
}

function elementChildren(el: HTMLElement, tags: string[]): HTMLElement[] {
  return el.childNodes.filter(
    (n) => n.nodeType === NodeType.ELEMENT_NODE && tags.includes(tagOf(n as HTMLElement)),
  ) as HTMLElement[];
}

function hasAncestor(el: HTMLElement | null, tag: string): boolean {
  for (let n = el; n; n = n.parentNode) if (tagOf(n) === tag) return true;
  return false;
}

/** Non-whitespace text nodes inside an element, in document order. */
function textNodes(el: HTMLElement): TextNode[] {
  const texts: TextNode[] = [];
  const collect = (node: HTMLElement): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.ELEMENT_NODE) collect(child as HTMLElement);
      else if (child.nodeType === NodeType.TEXT_NODE && /\S/.test((child as TextNode).text)) {
        texts.push(child as TextNode);
      }
    }
  };
  collect(el);
  return texts;
}

/** Wrap an element's text as " [marker: ...] ", noting the changed nodes' text in `sourceText`. */
function markInline(el: HTMLElement, marker: string, sourceText: Map<TextNode, string>): void {
  const texts = textNodes(el);
  if (!texts.length) return;
  const first = texts[0];
  const last = texts[texts.length - 1];
  for (const text of [first, last]) if (!sourceText.has(text)) sourceText.set(text, text.text);
  first.rawText = ` [${marker}: ${first.rawText}`;
  last.rawText += "] ";
}

/**
 * Prepare the text of table cells: " | " separates cells, so escape any "|"
 * in the text, and each table row stays on one line, so drop line breaks.
 */
function prepareCellText(node: HTMLElement, inCell: boolean): void {
  for (const child of node.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE) {
      prepareCellText(child as HTMLElement, inCell || tagOf(child as HTMLElement) === "entry");
    } else if (inCell && child.nodeType === NodeType.TEXT_NODE) {
      const text = child as TextNode;
      if (/[|\r\n]/.test(text.rawText)) text.rawText = text.rawText.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
    }
  }
}

interface CellPosition {
  start: number; // first and last column the cell covers
  end: number;
  slot: number; // the column its text is shown under (see layoutTables)
  tgroup: HTMLElement;
}

interface TableLayout {
  cells: Map<HTMLElement, CellPosition>; // entry -> position
  used: Map<HTMLElement, Set<number>>; // tgroup -> columns shown as slots
  rows: Map<HTMLElement, HTMLElement[][]>; // tgroup -> the cells of each row
}

/**
 * Work out the columns each table cell covers, following the CALS table
 * model (colspec names, namest/nameend and spanspec spans, morerows), so the
 * cells of a row with blank or spanned cells stay under the right headings.
 */
function layoutTables(root: HTMLElement): TableLayout {
  const layout: TableLayout = { cells: new Map(), used: new Map(), rows: new Map() };
  for (const tgroup of root.querySelectorAll("tgroup")) {
    const columns = new Map<string, number>();
    let colnum = 0; // a colspec without colnum follows the one before it
    for (const spec of elementChildren(tgroup, ["colspec"])) {
      const num = Number(spec.getAttribute("colnum"));
      colnum = num > 0 ? num : colnum + 1;
      const name = spec.getAttribute("colname");
      if (name) columns.set(name, colnum - 1);
    }
    const spans = new Map<string, [string | undefined, string | undefined]>();
    for (const spec of elementChildren(tgroup, ["spanspec"])) {
      const name = spec.getAttribute("spanname");
      if (name) spans.set(name, [spec.getAttribute("namest"), spec.getAttribute("nameend")]);
    }
    const placed: { cell: HTMLElement; start: number; end: number; filled: boolean }[] = [];
    const rows: HTMLElement[][] = [];
    for (const part of elementChildren(tgroup, ["thead", "tbody", "tfoot"])) {
      const held = new Map<number, Set<number>>(); // row -> columns taken by morerows cells above
      elementChildren(part, ["row"]).forEach((row, r) => {
        const taken = held.get(r) ?? new Set<number>();
        let col = 0;
        rows.push(elementChildren(row, ["entry"]));
        for (const cell of elementChildren(row, ["entry"])) {
          const span = spans.get(cell.getAttribute("spanname") ?? "");
          const startName = cell.getAttribute("namest") ?? span?.[0] ?? cell.getAttribute("colname");
          let start = startName !== undefined ? columns.get(startName) ?? -1 : -1;
          if (start < 0) {
            start = col;
            while (taken.has(start)) start++;
          }
          const endName = cell.getAttribute("nameend") ?? span?.[1];
          const endCol = endName !== undefined ? columns.get(endName) : undefined;
          const end = endCol !== undefined && endCol >= start ? endCol : start;
          placed.push({ cell, start, end, filled: /\S/.test(cell.text) });
          const more = Number(cell.getAttribute("morerows") ?? 0);
          for (let k = 1; k <= more; k++) {
            const below = held.get(r + k) ?? new Set<number>();
            for (let c = start; c <= end; c++) below.add(c);
            held.set(r + k, below);
          }
          col = end + 1;
        }
      });
    }
    // A column gets a slot when a one-column cell with text starts in it. A
    // cell spanning columns shows under the first such column it covers, or
    // its own first column if it covers none; other slots it covers stay empty.
    const used = new Set<number>();
    for (const p of placed) if (p.filled && p.start === p.end) used.add(p.start);
    for (const p of placed) {
      if (!p.filled || p.start === p.end) continue;
      let covered = false;
      for (let c = p.start; c <= p.end; c++) if (used.has(c)) covered = true;
      if (!covered) used.add(p.start);
    }
    for (const p of placed) {
      let slot = p.start;
      for (let c = p.start; c <= p.end; c++) {
        if (used.has(c)) {
          slot = c;
          break;
        }
      }
      layout.cells.set(p.cell, { start: p.start, end: p.end, slot, tgroup });
    }
    // Formulas set as tables get no blank-cell slots.
    layout.used.set(tgroup, hasAncestor(tgroup, "eqn") ? new Set() : used);
    layout.rows.set(tgroup, rows);
  }
  return layout;
}

/** Number of columns in `used` strictly between `from` and `to`. */
function columnsBetween(used: Set<number> | undefined, from: number, to: number): number {
  let count = 0;
  for (const c of used ?? []) if (c > from && c < to) count++;
  return count;
}

/**
 * In a two-row formula set as a table, fold each fraction (a cell ruled
 * underneath, with the denominator below it in the same column) into the
 * numerator's cell: "a / (b + c)".
 */
function foldFractions(layout: TableLayout): void {
  const filled = (cell: HTMLElement): boolean => /\S/.test(cell.text);
  for (const [tgroup, rows] of layout.rows) {
    if (!hasAncestor(tgroup, "eqn")) continue;
    const textRows = rows.filter((row) => row.some(filled));
    if (textRows.length !== 2) continue;
    const [top, bottom] = textRows;
    for (const numerator of top) {
      if (numerator.getAttribute("rowsep") !== "1" || !filled(numerator)) continue;
      const column = layout.cells.get(numerator)?.start;
      const denominator = bottom.find((cell) => filled(cell) && layout.cells.get(cell)?.start === column);
      if (!denominator) continue;
      bracketOperand(numerator);
      bracketOperand(denominator);
      numerator.insertAdjacentHTML("beforeend", ` / ${denominator.innerHTML}`);
      denominator.set_content("");
    }
  }
}

/** Bracket a formula operand that has operators of its own: "(b + c)". */
function bracketOperand(cell: HTMLElement): void {
  const value = cell.text.trim();
  if (!/[+×÷*\/−–]| - /.test(value) || isBracketed(value)) return;
  const texts = textNodes(cell);
  if (!texts.length) return;
  texts[0].rawText = texts[0].rawText.replace(/^\s*/, (ws) => `${ws}(`);
  const last = texts[texts.length - 1];
  last.rawText = last.rawText.replace(/\s*$/, (ws) => `)${ws}`);
}

function isBracketed(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0 && i < value.length - 1) return false;
  }
  return true;
}

/** Two neighbouring pieces of text and what lies between them. */
interface Boundary {
  before: TextNode;
  after: TextNode;
  gap: HTMLElement[]; // empty elements between them
  blanks: TextNode[]; // whitespace-only text between them
  space: string; // all the whitespace between them
}

/**
 * Give text from neighbouring elements the separator the elements call for
 * (see XML_SEPARATORS). Where the two texts touch, the separator is added.
 * Where the source has only stray whitespace between them (a trailing space
 * in a cell, a blank <summary>), a line break or " | " is still added unless
 * that whitespace already provides it. Each table row is kept on one line.
 * `marked` holds the elements rendered with a marker (see markerFor), and
 * `sourceText` the text that marked text nodes had before their markers.
 */
function separateAdjacentText(
  root: HTMLElement,
  marked: Set<HTMLElement>,
  sourceText: Map<TextNode, string>,
): void {
  const layout = layoutTables(root);
  foldFractions(layout);
  const context = { layout, marked, sourceText };
  let prev: TextNode | null = null;
  let gap: HTMLElement[] = [];
  let blanks: TextNode[] = [];
  let space = "";
  const visit = (node: HTMLElement): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (el.childNodes.length > 0) visit(el);
        else if (prev) gap.push(el);
        continue;
      }
      if (child.nodeType !== NodeType.TEXT_NODE) continue;
      const text = child as TextNode;
      const value = text.text;
      if (!/\S/.test(value)) {
        space += value;
        if (prev) blanks.push(text);
        continue;
      }
      if (prev) {
        separate({ before: prev, after: text, gap, blanks, space: space + /^\s*/.exec(value)![0] }, context);
      }
      prev = text;
      gap = [];
      blanks = [];
      space = /\s*$/.exec(value)![0];
    }
  };
  visit(root);
}

/**
 * The source text of the line that follows a brk within its parent, up to the
 * next brk, leaving out any markers added by markInline.
 */
function lineAfterBreak(brk: HTMLElement, sourceText: Map<TextNode, string>): string {
  const source = (node: Node): string => {
    if (node.nodeType === NodeType.TEXT_NODE) return sourceText.get(node as TextNode) ?? (node as TextNode).text;
    return node.childNodes.map(source).join("");
  };
  const siblings = brk.parentNode?.childNodes ?? [];
  let line = "";
  for (let i = siblings.indexOf(brk) + 1; i < siblings.length; i++) {
    if (tagOf(siblings[i] as HTMLElement) === "brk") break;
    line += source(siblings[i]);
  }
  return line;
}

/** Turn line breaks between the two texts into spaces, keeping a table row on one line. */
function flattenNewlines(b: Boundary): void {
  if (!/[\r\n]/.test(b.space)) return;
  const flat = (ws: string): string => ws.replace(/[\r\n]/g, " ");
  b.before.rawText = b.before.rawText.replace(/\s+$/, flat);
  for (const text of b.blanks) text.rawText = flat(text.rawText);
  b.after.rawText = b.after.rawText.replace(/^\s+/, flat);
}

/**
 * Add the separator needed at one boundary. The outermost elements meeting
 * there decide (two cells get " | " even though the paragraphs inside them
 * would get line breaks); inner elements only count when the outer ones have
 * no separator.
 */
function separate(
  b: Boundary,
  { layout, marked, sourceText }: { layout: TableLayout; marked: Set<HTMLElement>; sourceText: Map<TextNode, string> },
): void {
  const { before, after, space } = b;
  const beforeAncestors = new Set<HTMLElement>();
  for (let n = before.parentNode; n; n = n.parentNode) beforeAncestors.add(n);
  // Elements starting at the boundary (containing only `after`) and ending
  // there (containing only `before`), outermost first.
  const starting: HTMLElement[] = [];
  let common: HTMLElement | null = after.parentNode;
  while (common && !beforeAncestors.has(common)) {
    starting.unshift(common);
    common = common.parentNode;
  }
  const ending: HTMLElement[] = [];
  for (let n = before.parentNode; n && n !== common; n = n.parentNode) ending.unshift(n);

  // The space after a label keeps "299 Purpose of register" on one line,
  // unless a table row starts there.
  if (XML_SPACE_AFTER_TAGS.has(tagOf(ending[0])) && !starting.some((el) => tagOf(el) === "row")) return;
  // follow-text continues a sentence after a list ("...Act 1989.").
  const follow = starting.find((el) => tagOf(el) === "follow-text");
  if (follow) {
    if (!space && follow.getAttribute("space-before") !== "no") before.rawText += " ";
    return;
  }
  // Marked text is set off by its marker; blocks inside a footnote or
  // struck-out words don't break the sentence around it. A table inside one
  // still ends its last row.
  const upToMarked = (chain: HTMLElement[], endingHere: boolean): HTMLElement[] => {
    const i = chain.findIndex((el) => marked.has(el));
    if (i < 0 || (endingHere && chain.slice(i).some((el) => tagOf(el) === "row"))) return chain;
    return chain.slice(0, i + 1);
  };
  const start = upToMarked(starting, false);
  const end = upToMarked(ending, true);
  // Empty elements between the texts count at their own depth.
  const gap: { el: HTMLElement; depth: number }[] = [];
  for (const el of b.gap) {
    let depth = 0;
    let insideMarked = false;
    for (let n = el.parentNode; n && n !== common; n = n.parentNode) {
      depth++;
      if (marked.has(n)) insideMarked = true;
    }
    if (!insideMarked) gap.push({ el, depth });
  }

  let sep = "";
  let from: HTMLElement | undefined; // the element that calls for sep
  const consider = (el: HTMLElement | undefined, endingHere: boolean): void => {
    const candidate = el ? XML_SEPARATORS.get(tagOf(el)) : undefined;
    // An element ending at the boundary only calls for a line or cell break.
    if (!candidate || (endingHere && candidate !== "\n" && candidate !== " | ")) return;
    if (SEPARATOR_STRENGTH.indexOf(candidate) > SEPARATOR_STRENGTH.indexOf(sep)) {
      sep = candidate;
      from = el;
    }
  };
  let deepest = Math.max(start.length, end.length);
  for (const g of gap) deepest = Math.max(deepest, g.depth + 1);
  for (let depth = 0; !sep && depth < deepest; depth++) {
    consider(start[depth], false);
    consider(end[depth], true);
    for (const g of gap) if (g.depth === depth) consider(g.el, false);
  }
  if (!sep) return;

  // Is the boundary inside one table cell, does it go into or out of a table
  // nested in a cell, and is the table a formula? (Table structure comes
  // from the full chains: a marked element can contain a table.)
  let part: HTMLElement | null = common;
  while (part && !TABLE_PARTS.has(tagOf(part))) part = part.parentNode;
  const leavingTable = ending.some((el) => tagOf(el) === "tgroup");
  const nestedTable = leavingTable || starting.some((el) => tagOf(el) === "tgroup");
  const formula = hasAncestor(common, "eqn");

  if (sep === "\n" && tagOf(part) === "entry" && !nestedTable) {
    // Within a cell, blocks are joined with " / " so the row stays on one
    // line. A brk is a wrapped line, so a space, unless it ends a field or
    // an item ("Name of building:", "[State how ...]", "*Select one").
    flattenNewlines(b);
    const line = from && tagOf(from) === "brk" ? lineAfterBreak(from, sourceText) : "";
    const item = /[:?.;\]—]\s*$/.test(sourceText.get(before) ?? before.text) ||
      /^\s*(\*|\[[^\]]*\][^\w\s]*\s*$|[A-Z][^:]*:\s*$)/.test(line);
    if (tagOf(from) !== "brk" || item) before.rawText += " / ";
    else if (!space) before.rawText += " ";
  } else if (sep === "\n" || (sep === " | " && nestedTable)) {
    // A new line; a table nested in a cell also gets lines of its own.
    let cell = [...starting].reverse().find((el) => tagOf(el) === "entry");
    // Text after a nested table, still in the outer cell, keeps that cell's column.
    for (let n = common; !cell && leavingTable && n; n = n.parentNode) if (tagOf(n) === "entry") cell = n;
    // Blank cells at the start of a row keep their columns: "| Mokihinui".
    const pos = cell ? layout.cells.get(cell) : undefined;
    const slots = pos ? columnsBetween(layout.used.get(pos.tgroup), -1, pos.slot) : 0;
    const prefix = (/[\r\n]/.test(space) ? "" : "\n") + "| ".repeat(slots);
    if (prefix) after.rawText = after.rawText.replace(/^\s*/, (ws) => ws + prefix);
  } else if (sep === " | ") {
    flattenNewlines(b);
    if (formula) {
      if (!space) before.rawText += " ";
      return;
    }
    // Blank and spanned-over columns between two cells keep their slots:
    // "4 D. 71. | | James Brandreth."
    const left = layout.cells.get(end[0]);
    const right = layout.cells.get(start[0]);
    const slots = left && right && left.tgroup === right.tgroup
      ? columnsBetween(layout.used.get(left.tgroup), left.slot, right.slot)
      : 0;
    before.rawText += " | ".repeat(slots + 1);
  } else if (sep === "/") {
    before.rawText += space ? " / " : "/";
  } else if (!space) {
    before.rawText += sep;
  }
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
export function findSection(root: HTMLElement, id: string, exclude: ExcludeOption[] = []): SectionResult | null {
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
    text: renderElementText(prov, exclude),
  };
}

/**
 * Find a schedule by number.
 * Schedules live under <schedule.group>, separate from <body>.
 */
export function findSchedule(root: HTMLElement, id: string, exclude: ExcludeOption[] = []): ScheduleResult | null {
  const normalised = id.trim();
  const schedules = root.querySelectorAll("schedule");
  const sched = schedules.find((s) => directLabel(s) === normalised);
  if (!sched) return null;
  return {
    number: normalised,
    heading: directHeading(sched),
    text: renderElementText(sched, exclude),
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
