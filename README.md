# legislation-nz-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes the **New Zealand [legislation.govt.nz developer API](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/)**
as tools an LLM (e.g. Claude) can call — search legislation, browse
point-in-time versions, and read the text of acts, bills, and secondary
legislation.

Built with Node + TypeScript and the official MCP SDK, over stdio.

## Tools

| Tool | What it does |
| --- | --- |
| `search_legislation` | Search by title or full-text content, with filters (type, status, agency, sort, pagination). Returns works + their newest matching version id. |
| `list_versions` | List all point-in-time versions of a work (by `work_id`). |
| `get_version_details` | Metadata for one version, including available formats (html/pdf/xml) and their URLs. |
| `get_legislation_text` | Read a document's text. Give a `version_id`, or a `work_id` to auto-read its newest version. Returns cleaned plain text (whole document). |

Typical flow: `search_legislation` → pick a `work_id`/`version_id` →
`get_legislation_text`.

## Setup

Requires Node.js 18+ (developed on Node 26) and an API key. Request a key on the
[developer API page](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/).

```bash
npm install
npm run build
```

Provide your API key. **Recommended:** create a `.env` file in the project root
— the server loads it automatically at startup, so the key stays out of your
shell environment and out of the MCP client config:

```bash
cp .env.example .env
# then edit .env and set LEGISLATION_NZ_API_KEY=...
```

The `.env` file is gitignored. Precedence: a `LEGISLATION_NZ_API_KEY` already
set in the environment (e.g. via an MCP client `env` block, below) wins over the
`.env` file. So you can use whichever approach suits you — `.env` file, an `env`
block in the client config, or a plain shell `export`.

### Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "legislation-nz": {
      "command": "node",
      "args": ["/absolute/path/to/legislation-nz-mcp/dist/index.js"],
      "env": {
        "LEGISLATION_NZ_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Use with Claude Code

```bash
claude mcp add legislation-nz \
  --env LEGISLATION_NZ_API_KEY=your_api_key_here \
  -- node /absolute/path/to/legislation-nz-mcp/dist/index.js
```

## API notes

- **Base URL:** `https://api.legislation.govt.nz`
- **Auth:** `X-Api-Key` header (handled by the client).
- **Rate limits:** 10,000 requests/day per key; 2,000 requests / 5 min per IP.
  The client retries transient throttling (429/503) with backoff.
- The API returns document **metadata**; the actual text lives behind the
  `formats[].url` links, which `get_legislation_text` fetches and cleans.

## Documentation discrepancies (feedback for the API provider)

While building against the live API (`/v0/` endpoints) we found several places
where the **observed responses differ from what the documentation at
`https://api.legislation.govt.nz/docs/` describes or implies**. Each item below
caused a real bug until the client was adjusted. These may be worth correcting
in the docs.

> Caveat: our reading of the docs was via an automated fetch, and the
> `learn-more/legislation-data/developer-api/` page returns HTTP 403 to
> automated requests so we could not read it. Verify each point against the
> canonical documentation before acting on it. The *observed API behaviour*
> below is confirmed against live responses (Privacy Act 2020,
> `work_id=act_public_2020_31`, July 2026).

1. **List responses are wrapped in a `results` envelope, not a bare array.**
   The docs describe search/versions responses as a "JSON array of works /
   versions". The API actually returns an object:
   `{ "results": [ ... ], "total": N, "page": N, "per_page": N }`.
   This applies to both `GET /v0/works/` and `GET /v0/works/{work_id}/versions/`.
   Code expecting a top-level array (or a `works`/`versions` key) silently gets
   zero results.

2. **`title` is not on the work object — only on the version.**
   In `GET /v0/works/` results, each work has **no top-level `title`**; the
   human-readable title appears only inside `latest_matching_version.title`.
   The docs list `title` among the standard top-level response fields, which
   implies it sits on the work.

3. **There is no `version_date` (or similar) date field on versions.**
   Version objects expose no discrete effective-date field. The date is only
   available encoded in the trailing segment of `version_id`
   (e.g. `act_public_2020_31_en_2026-05-01` → `2026-05-01`). A first-class date
   field, or explicit documentation that the date must be parsed from the id,
   would help.

4. **`administering_agencies` is an array of strings in responses.**
   The docs describe `administering_agencies` as a string (an agency name),
   which is true for the *request* filter, but in *responses* the field is a
   JSON array (e.g. `["Ministry of Justice"]`). The request/response type
   difference is undocumented.

5. **The `html` format URL returns the full website page, not a content-only
   document.** For a version, `formats[]` lists `html`, `pdf`, and `xml`. The
   `html` URL (e.g. `.../en/latest/`) serves the complete legislation.govt.nz
   web page — site navigation, bilingual menus, headers/footers — rather than
   just the legislation content. Consumers wanting the text must use the `xml`
   format (clean, content-only) or scrape the page. Documenting that `html` is
   the website rendering and `xml` is the machine-readable content would set
   expectations. (This tool now defaults to `xml` for `get_legislation_text`.)

6. **Minor: `work_id` / `version_id` formats.** Observed identifiers are not
   zero-padded (`act_public_2020_31`, not `act_public_2020_0031`). Version ids
   follow `work_id + "_" + language + "_" + ISO-date`
   (`act_public_2020_31_en_2026-05-01`). A precise, documented grammar for these
   identifiers would reduce guesswork.

## Roadmap — deferred features

These were intentionally left out of v0.1 to keep the first version simple.
Notes here so they aren't forgotten.

### 1. Structured, per-section text extraction (XML parsing) — _high value_
`get_legislation_text` already fetches the official **XML** format and flattens
it to a readable whole-document text blob ("Option A" — see `xmlToText` in
`src/format.ts`). The next step ("Option B") is to parse that same XML into its
provision tree (Part → subpart → section → subsection) so we can:
- Add a `section` parameter to `get_legislation_text` that returns **just one
  provision** (with its heading and parent Part for context) instead of the
  whole act — far cheaper on tokens and better for precise citation.
- Preserve document hierarchy in output rather than flattening it.

This requires server-side manipulation the API does not do for us: fetch full
XML → parse against the NZ legislation schema (`<prov>` / `<label>` /
`<heading>` / `<subprov>` / `<label-para>` elements, observed live) → locate the
requested node → return that subtree.

### 2. PDF retrieval / handling
`get_legislation_text` reads the XML format (falling back to HTML); it never
uses the PDF. A user may still want the official PDF — e.g. for printing or for
documents where layout matters. Consider a tool/param to surface the PDF format
URL, or to extract text from the PDF.

### 3. "Notify me of changes" / feeds
The API has **legacy RSS endpoints** (`/api/rss/search/` and
`/api/rss/works/{work_id}/versions/`) that mirror the `/v0/` JSON endpoints but
return RSS/Atom feeds for feed-reader subscriptions. We deliberately skipped
these — the JSON `/v0/` endpoints are a strict superset for on-demand querying.
If a change-monitoring feature is ever wanted, prefer **polling `/v0/` and
diffing versions** over parsing RSS, rather than adding the RSS endpoints.

### 4. Caching layer
Add an in-memory (or on-disk) cache for document fetches and version lists to
reduce calls against the daily quota for repeated reads of the same work.

### 5. Response-shape hardening
The `/v0/` JSON responses are typed loosely (`src/types.ts`) because there is no
published machine-readable schema. Once field names are confirmed against live
responses, tighten the types and the result-summarizing code.
```

## Project layout

```
src/
├─ index.ts              # MCP server bootstrap (stdio) + tool registration
├─ client.ts             # HTTP client: auth, retries, rate-limit handling
├─ types.ts              # loose response types
├─ format.ts             # HTML → clean text (Option A)
└─ tools/
   ├─ search.ts          # search_legislation
   ├─ versions.ts        # list_versions
   ├─ versionDetails.ts  # get_version_details
   └─ getText.ts         # get_legislation_text
```

## License

MIT
