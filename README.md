# legislation-nz-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
**New Zealand [legislation.govt.nz developer API](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/)**.

It lets an MCP client such as Claude search New Zealand legislation, browse
every point-in-time version of an Act, Bill, or piece of secondary legislation,
and read the text of a single section or schedule, all through the official
API published by the Parliamentary Counsel Office (PCO).

Written in TypeScript on the official MCP SDK. It runs over stdio for local
clients (Claude Desktop, Claude Code, Cursor, and any other MCP client) or over
streamable HTTP as a standalone localhost service.

## What it can do

Ask your assistant things like:

- "What does section 22 of the Privacy Act 2020 say?"
- "List every version of the Crimes Act 1961 and give me the one in force on
  1 July 2013."
- "Which Acts mention 'notifiable privacy breach'?"
- "Show me all in-force secondary legislation administered by the Takeovers
  Panel."
- "What is the structure of the Trusts Act 2019, and which Part covers
  trustees' duties?"
- "Give me the PDF of the Crimes Act as originally enacted in 1961."
- "How much of my daily API quota is left?"

Every answer comes with the official website link for the work or version so
a reader can verify it at the source.

## Tools

| Tool | What it does |
| --- | --- |
| `search_legislation` | Search by title or full text with every filter the API offers, or browse by filters alone. Returns matching works, their newest matching version, website URLs, and a flag for content matches that only hit an older version. |
| `list_versions` | Every point-in-time version of a work, with the work's metadata reported once at the top. Fetches all pages automatically, or one page on request. |
| `get_version_details` | Metadata for a single version, including the download URLs for each available format (`html`, `pdf`, `xml`, `pdf_original_scan`). |
| `list_sections` | The structure of a document: Parts, subparts, section numbers and headings, and schedules. Use it to find a section number before reading text. |
| `get_legislation_text` | The text of a whole document, a single section, or a single schedule, as clean plain text from the official XML. Can also return a PDF download URL instead. |
| `search_legislation_rss` | The same search through the legacy Atom feed endpoint, returning parsed feed entries and a subscribable feed URL. Needs a separate RSS key. |
| `list_versions_rss` | A work's version history as an Atom feed, with a subscribable URL for change monitoring. Needs a separate RSS key. |
| `get_rate_limit_status` | Remaining daily quota for the API key and the feed key, read from the API's rate-limit response headers. |

### Typical workflows

**Read one section of an Act**

1. `search_legislation` with `search_term: "Privacy Act 2020"` gives the
   `work_id` `act_public_2020_31`.
2. `list_sections` with that `work_id` lists every Part and section heading.
3. `get_legislation_text` with `work_id` and `section: "22"` returns just that
   section, with its Part and subpart context.

**Read the law as it stood on a date**

1. `list_versions` with the `work_id` lists every version with its effective
   date.
2. `get_legislation_text` with the chosen `version_id` and a `section` or
   `schedule`.

**Find legislation by what it says**

`search_legislation` with `search_field: "content"` searches the body of every
document rather than titles. Wrap a phrase in double quotes to require the
exact words; otherwise stemming is on and "levy" also matches "levies".

**Browse without a search term**

Omit `search_term` and pass filters alone. Type-specific filters imply the
type, so `act_status: "in_force"` on its own returns in-force Acts, and
`instrument_type_group: "regulations"` returns only regulations.

### Tool reference

#### `search_legislation`

| Parameter | Notes |
| --- | --- |
| `search_term` | Optional. ElasticSearch simple query syntax. Omit to browse by filters. |
| `search_field` | `title` (default) or `content` for full text. |
| `legislation_type` | `act`, `bill`, `secondary_legislation`, `amendment_paper`. Inferred from a type-specific filter when omitted. |
| `legislation_status` | `in_force`, `not_in_force`, `no_value`. |
| `act_type`, `act_classification`, `act_status` | Acts only. |
| `bill_type`, `bill_status` | Bills only. |
| `instrument_type_group`, `instrument_status`, `instrument_classification` | Secondary legislation only. |
| `administering_agencies` | The agency's full name exactly as listed on the [browse agencies page](https://www.legislation.govt.nz/browse/agencies). |
| `publisher` | `Parliamentary Counsel Office` or `Agency`. |
| `sort_by` | `title_asc`, `title_desc`, `year_asc`, `year_desc`, `most_recently_updated`. |
| `page`, `per_page` | Default 20 per page, maximum 100. |

Mixing filters from two types, or contradicting an explicit
`legislation_type`, returns a clear error rather than an empty result.

Each result includes `work_id`, `title`, `url` (the work's `latest` page),
`publisher`, `administering_agencies`, the type-specific fields, and the
matching version: `latest_matching_version_id`, its date, its URL, the format
types it offers, and `latest_matching_version_is_latest`. That last flag is
`false` when a content search matched only an older version, for example text
that has since been repealed.

#### `list_versions`

Takes a `work_id` and optional `sort` (`desc` by default). With no `page` it
fetches every page (the API serves at most 100 per page) and returns them all,
with `pages_fetched` and a `truncated` flag. With `page` (and optionally
`per_page`) it returns one page with `has_more`.

Work-level metadata (title, type, status, agencies) is reported once at the
top. Each version carries its `version_id`, `version_date`, `url`, and format
types; the newest version carries `is_latest_version: true`.

#### `get_version_details`

Takes a `version_id`. Returns the version's metadata, its `url`, the work's
`work_url`, and `formats[]` with a download URL for each format.

#### `list_sections`

Takes a `version_id` or a `work_id` (the newest version is used). Returns
`parts[]` with their subparts and sections, any sections outside a Part, and
`schedules[]`. Needs the XML format, which all PCO-published documents have.

#### `get_legislation_text`

| Parameter | Notes |
| --- | --- |
| `version_id` or `work_id` | One is required. A `work_id` resolves to the newest version. |
| `section` | A section number such as `"22"` or `"25A"`. Returns only that provision with its Part and subpart. |
| `schedule` | A schedule number such as `"1"`. |
| `format` | `pdf` returns the PDF download URL instead of text. `pdf_original_scan` returns the scan of the original printed Act, which only as-enacted versions of pre-2008 Acts have. |
| `max_chars` | Truncates whole-document output (default 100,000 characters). Not applied to a single section or schedule. |
| `exclude` | Content types to strip: `cover`, `history_notes`, `comparative_references`, `editorial_notes`, `defined_term_links`, `end_matter`. Everything is kept by default. |

Text comes from the official XML format, which carries the document structure.
The HTML format is only a fallback, because it is the full website page. The
table of contents is always dropped, since `list_sections` covers it better.

#### `search_legislation_rss` and `list_versions_rss`

These call the two legacy feed endpoints in the API documentation. They need a
separate RSS-only key (see Setup). Entries are returned parsed: title, website
URL, timestamps, and a derived `work_id` and, for dated entries, `version_id`,
so results can be passed straight to the JSON tools. Each response includes
the public `feed_url` (without your key) for subscribing in a feed reader. The
search feed accepts `search_term`, `search_field` (`title` or `content`),
`legislation_type`, `legislation_status`, and a client-side `limit`; it returns
at most 100 entries and does not paginate.

#### `get_rate_limit_status`

Returns the latest quota figures for the API key and the feed key: limit,
remaining, and when the quota resets, in UTC and New Zealand time. By default
it spends one minimal request to refresh the API figure; `refresh` can be
`api`, `rss`, `both`, or `none`.

### Quota on every response

Every tool result carries a `rate_limit` object taken from the response
headers of the request the tool just made:

```json
"rate_limit": {
  "scope": "api",
  "limit": 10000,
  "remaining": 9997,
  "resets_at": "2026-09-22T12:00:00.000Z",
  "resets_at_nz": "23/09/2026, 12:00:00 am NZST"
}
```

### Links and ephemeral identifiers

Results carry website links (`url`) built from the identifiers, following the
URL pattern the API documents: a work links to its `latest` alias and a
version to its dated page. Identifiers containing `~` are ephemeral (built
from fallback data for agency-published legislation and liable to change) and
carry `ephemeral: true`.

## Setup

### Requirements

- Node.js 18 or later.
- A legislation.govt.nz developer API key. Request one on the
  [developer API page](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/).
- Optionally, an RSS-only key for the two feed tools. The feeds reject the
  regular API key, and the other six tools do not need the RSS key.

### Install and build

```bash
git clone https://github.com/ezydubs/legislation-nz-mcp.git
cd legislation-nz-mcp
npm install
npm run build
```

### Provide the API key

The recommended way is a `.env` file in the project root. The server loads it
at startup, so the key stays out of your shell and out of your MCP client
config:

```bash
cp .env.example .env
# edit .env and set LEGISLATION_NZ_API_KEY=...
```

`.env` is gitignored. A key already set in the environment, for example via an
MCP client `env` block, takes precedence over the file.

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

Leave out the `env` block if you use a `.env` file.

### Use with Claude Code

```bash
claude mcp add legislation-nz -- node /absolute/path/to/legislation-nz-mcp/dist/index.js
```

Add `--env LEGISLATION_NZ_API_KEY=your_api_key_here` if you are not using a
`.env` file. Add `-s user` to make the server available in every project.

### Use with other MCP clients

Any client that can launch a stdio server works: the command is `node` and the
single argument is the absolute path to `dist/index.js`.

### Run over HTTP

The server can also run as its own localhost HTTP service, for example behind
a reverse proxy or gateway that handles authentication:

```bash
npm run start:http
```

It serves the MCP streamable HTTP transport at `http://127.0.0.1:8091/mcp`.
Override the bind address with `LEGISLATION_HTTP_HOST` and
`LEGISLATION_HTTP_PORT`. The HTTP entry point has no authentication of its own
and must not be exposed on a public interface.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `LEGISLATION_NZ_API_KEY` | Yes | Key for the JSON API (10,000 requests/day). |
| `LEGISLATION_NZ_RSS_API_KEY` | No | RSS-only key for the two feed tools (1,500 requests/day). |
| `LEGISLATION_HTTP_HOST` | No | Bind address for the HTTP transport (default `127.0.0.1`). |
| `LEGISLATION_HTTP_PORT` | No | Port for the HTTP transport (default `8091`). |

## How it works

- **Search and metadata** come from the JSON API at
  `https://api.legislation.govt.nz/v0/`.
- **Document text** is fetched from the `formats[].url` links a version
  advertises. The XML format is parsed to find a section by its label inside
  the main body only, so schedule provisions with the same number never
  collide, and to walk up to the enclosing Part and subpart.
- **Feeds** come from `https://www.legislation.govt.nz/api/rss/`, are parsed
  as Atom, and have their website URLs mapped back to identifiers.
- **Quota headers** on every response are recorded per key and reported.
- **Errors** are returned as MCP tool errors with readable messages, never as a
  crashed server.

### Key handling

- The API key is sent only to `legislation.govt.nz` hosts. Agency-published
  secondary legislation can link to the agency's own website, and no key is
  sent there.
- The feed key travels in the query string because the feed endpoints accept
  nothing else. It is scrubbed from any error text and never included in the
  `feed_url` returned to the client.
- Keys never appear in tool output.

### Retries

Transient upstream errors (502, 503, 504) are retried up to three times with
capped backoff. A 429 is not retried: it means the daily quota is spent until
midnight New Zealand time, and the error message says when that is. A 403
means the burst limit (2,000 requests per five minutes per IP) was hit.

## API notes

- **Base URLs:** `https://api.legislation.govt.nz` for the JSON API;
  `https://www.legislation.govt.nz/api/rss/` for the legacy feeds.
- **Auth:** `X-Api-Key` header for the JSON API; `api_key` query parameter for
  the feeds.
- **Rate limits:** 10,000 requests/day per API key, 1,500/day per feed key,
  2,000 requests per five minutes per IP. Quotas reset at midnight NZ time.
- The API returns document **metadata**; the text itself lives behind the
  `formats[].url` links.
- Official documentation: <https://api.legislation.govt.nz/docs/>.

### Observed API behaviour

The following notes record places where the live API behaves differently from
what the published documentation implies. Each one affected the client
implementation and may be useful to others building against the same API.
Behaviour was verified against live responses in September 2026; confirm
against the canonical documentation before relying on any point.

1. **List responses use a `results` envelope, not a bare array.** Search and
   version listings return
   `{ "results": [ ... ], "total": N, "page": N, "per_page": N }`.

2. **`title` is on the version, not the work.** In search results a work has
   no top-level `title`; it appears only in `latest_matching_version.title`.

3. **Versions carry no discrete date field.** The effective date is encoded in
   the trailing segment of `version_id`
   (e.g. `act_public_2020_31_en_2026-05-01`), possibly with a deduplication
   suffix letter (`2020-06-30B`), and must be parsed from the id.

4. **`administering_agencies` is a string filter but an array in responses.**

5. **The `html` format URL returns the full website page**, with navigation
   and menus. The `xml` format is the clean, machine-readable content.

6. **Identifiers are not zero-padded.** Observed ids are `act_public_2020_31`,
   not `act_public_2020_0031`.

7. **The versions endpoint paginates, and accepts `page`/`per_page`.** The
   documentation lists neither parameter for it, but the default page holds
   20 versions and both parameters work; `per_page` is capped at 100. The
   Income Tax Act 2007 has 206 versions, so a full listing takes three
   requests.

8. **The versions endpoint does not send `is_latest_version`**, only search
   does. The server derives it from the sort order.

9. **The legacy feeds live on a different host, need a different key, and are
   Atom.** `/api/rss/search/` and `/api/rss/works/{work_id}/versions/` return
   404 on `api.legislation.govt.nz`; they are served from
   `www.legislation.govt.nz`. They accept the key only as the `api_key` query
   parameter, and a regular API key is rejected (`401 Unauthorized API key`).
   The body is an Atom 1.0 feed, not RSS 2.0. The search feed returns up to
   100 entries and ignores `page` and `per_page`. The documented
   `search_field=fulltext` value returns no entries at all; the feed honours
   `content`, so the tool sends `content` for either. An unknown `work_id` in
   the versions feed returns HTTP 200 with `<id>not_found</id>` and no
   entries rather than a 404.

10. **Agency-published secondary legislation links off-site.** Its format URLs
    can point at the agency's own website, and such records usually offer
    only a PDF, so `list_sections` and text extraction are unavailable for
    them. `get_legislation_text` with `format: "pdf"` returns the link.

## Development

```bash
npm run build      # compile to dist/
npm run dev        # compile on change
npm run typecheck  # type-check without emitting
npm start          # run the stdio server
npm run start:http # run the HTTP server
```

There is no automated test suite yet. Changes have been verified with a stdio
MCP client script exercising every tool against the live API, and with a
script that extracts the OpenAPI spec from the docs page and checks every
path, parameter, enum value, response field, and header against the source.

## Limitations and future work

- **No caching.** Every call hits the API. An in-memory or on-disk cache for
  document fetches and version lists would stretch the daily quota for
  repeated reads.
- **Agency-published documents** are usually PDF-only and hosted off-site, so
  their text cannot be extracted.
- **Change monitoring.** A "notify me of changes" feature could poll the
  version feed from `list_versions_rss` and diff versions.

## Project layout

```
src/
├─ index.ts             # stdio entry point (Claude Desktop / Claude Code)
├─ http.ts              # streamable HTTP entry point (localhost service)
├─ server.ts            # transport-independent server factory; registers all tools
├─ client.ts            # HTTP client: auth, retries, rate-limit headers, feed fetching
├─ types.ts             # API response types (confirmed against live responses)
├─ util.ts              # response envelope, version dates, website URLs, ephemeral ids
├─ format.ts            # HTML → plain text
├─ xml.ts               # XML parsing and document-structure extraction
├─ feed.ts              # Atom feed parsing for the legacy /api/rss/ endpoints
└─ tools/
   ├─ search.ts         # search_legislation
   ├─ versions.ts       # list_versions
   ├─ versionDetails.ts # get_version_details
   ├─ listSections.ts   # list_sections
   ├─ getText.ts        # get_legislation_text
   ├─ searchRss.ts      # search_legislation_rss
   ├─ versionsRss.ts    # list_versions_rss
   ├─ rateLimit.ts      # get_rate_limit_status
   └─ resolve.ts        # work_id → newest version_id helper
```

## License

MIT
