// Regression tests for section and schedule lookup, against trimmed excerpts
// of real PCO XML (see the comment at the top of each fixture).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    parseLegislation,
    findSection,
    findSchedule,
    buildStructure,
    documentKind,
} from "../dist/xml.js";

const load = (name) =>
    parseLegislation(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const allSections = (structure) => [
    ...structure.ungroupedSections,
    ...structure.parts.flatMap((p) => [...p.sections, ...p.subparts.flatMap((s) => s.sections)]),
];

test("a section quoted earlier in an amendment Act is not returned in place of the Act's own", () => {
    const root = load("statutes-amendment-2025-s40.xml");
    const s40 = findSection(root, "40");
    assert.equal(s40.heading, "Section 4 amended (Interpretation)");
    assert.equal(s40.status, undefined);
    assert.equal(s40.other_matches, undefined);
    assert.equal(s40.warning, undefined);
});

test("quoted sections in a regulatory systems Act are ignored", () => {
    const root = load("regulatory-systems-transport-2026-schedules.xml");
    const s19 = findSection(root, "19");
    assert.match(s19.heading, /^Section 30S amended/);
});

test("quoted schedules are neither returned nor listed", () => {
    const root = load("regulatory-systems-transport-2026-schedules.xml");
    // The fixture has 11 <schedule> elements: the Act's own Schedules 1 to 5,
    // and 6 quoted schedules numbered 1 or 2 inside them.
    assert.equal(root.querySelectorAll("schedule").length, 11);
    assert.deepEqual(
        buildStructure(root).schedules.map((s) => s.number),
        ["1", "2", "3", "4", "5"],
    );
    assert.match(findSchedule(root, "1").heading, /^New Part 4 of Schedule 1AA of Maritime Transport Act 1994 inserted/);
    assert.match(findSchedule(root, "2").heading, /^New Schedule 1 of Auckland Airport Act 1987 inserted/);
});

test("a reused section number returns the current section and says another exists", () => {
    const root = load("crimes-1961-s253-s254.xml");
    const s253 = findSection(root, "253");
    assert.equal(s253.heading, "Designing, writing, or adapting software for committing certain crimes");
    assert.equal(s253.status, undefined);
    assert.deepEqual(s253.other_matches, [
        {
            heading: "Qualified exemption to access without authorisation offence for New Zealand Security Intelligence Service",
            status: "repealed",
        },
    ]);
    assert.match(s253.warning, /2 provisions numbered 253/);
    assert.match(s253.warning, /repealed/);
});

test("the current section wins even when the repealed one comes first", () => {
    // Swap the document order of the two s 254s.
    const xml = readFileSync(new URL("./fixtures/crimes-1961-s253-s254.xml", import.meta.url), "utf8");
    const provs = parseLegislation(xml).querySelectorAll("prov").filter((p) => p.querySelector("label")?.text.trim() === "254");
    const [current, repealed] = provs.map((p) => p.outerHTML);
    const swapped = xml.replace(current, "@@CURRENT@@").replace(repealed, current).replace("@@CURRENT@@", repealed);
    const s254 = findSection(parseLegislation(swapped), "254");
    assert.equal(s254.heading, "Dealing in or possessing software or other information for committing crime");
    assert.equal(s254.other_matches[0].status, "repealed");
});

test("a lone non-current section carries its status", () => {
    const root = load("crimes-1961-s253-s254.xml");
    const s312L = findSection(root, "312L");
    assert.equal(s312L.status, "not_in_force");
    assert.equal(s312L.other_matches, undefined);
});

test("list_sections marks repealed sections", () => {
    const listed = allSections(buildStructure(load("crimes-1961-s253-s254.xml")));
    assert.deepEqual(
        listed.filter((s) => s.number === "253").map((s) => s.status),
        [undefined, "repealed"],
    );
});

test("a bill clause struck out and reinserted returns the inserted clause", () => {
    const root = load("crimes-amendment-bill-cl17A.xml");
    const cl17A = findSection(root, "17A");
    assert.equal(cl17A.status, undefined);
    assert.doesNotMatch(cl17A.text, /\[deleted:/);
    assert.match(cl17A.text, /delete or section 98D/);
    assert.equal(cl17A.other_matches[0].status, "struck_out");
    assert.deepEqual(
        allSections(buildStructure(root)).filter((s) => s.number === "17A").map((s) => s.status),
        ["struck_out", undefined],
    );
});

test("an amendment paper has no provisions of its own", () => {
    const root = load("sop-660.xml");
    assert.equal(documentKind(root), "sop");
    assert.equal(findSection(root, "17A"), null);
    assert.equal(allSections(buildStructure(root)).length, 0);
});

test("provisions and schedules of other Acts in end-matter skeletons are ignored", () => {
    // Synthetic: shaped like the Crimes Act's <end><skeletons>.
    const root = parseLegislation(
        "<act><body><prov><label>1</label><heading>Own section</heading></prov></body>" +
            "<end><skeletons><skeleton.act><skeleton.act.body><prov><label>2</label><heading>Other Act</heading></prov>" +
            "</skeleton.act.body><schedule><label>1</label><heading>Other Act's schedule</heading></schedule>" +
            "</skeleton.act></skeletons></end></act>",
    );
    assert.equal(findSection(root, "2"), null);
    assert.equal(findSchedule(root, "1"), null);
    assert.deepEqual(buildStructure(root).schedules, []);
    assert.equal(documentKind(root), "act");
});

test("the as-at date a document declares is read from its root element", async () => {
    const { documentAsAt } = await import("../dist/xml.js");
    assert.equal(
        documentAsAt('<?xml version="1.0"?>\n<act xml:lang="en-NZ" act.no="43" date.as.at="2026-08-08" date.assent="1961-11-01">'),
        "2026-08-08",
    );
    assert.equal(documentAsAt('<regulation date.as.at="2026-09-21" sr.no="288">'), "2026-09-21");
    assert.equal(documentAsAt('<bill bill.no="223" stage="3">'), undefined);
    // Only the root element counts.
    assert.equal(documentAsAt('<sop sop.no="660"><act date.as.at="2020-01-01"></act></sop>'), undefined);
});

test("a document whose as-at date differs from the requested version is refused", async () => {
    const { checkDocumentVersion } = await import("../dist/tools/getText.js");
    const xml = '<act act.no="74" date.as.at="2026-01-15">';
    assert.throws(
        () => checkDocumentVersion(xml, "act_public_2025_74_en_2025-11-26B"),
        /is dated 2026-01-15, not 2025-11-26/,
    );
    assert.equal(checkDocumentVersion('<act date.as.at="2025-11-26">', "act_public_2025_74_en_2025-11-26B"), "2025-11-26");
    assert.equal(checkDocumentVersion('<bill stage="3">', "bill_government_2025_223_en_2026-07-29"), undefined);
});
