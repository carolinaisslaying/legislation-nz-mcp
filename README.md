# legislation-nz-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
**New Zealand [legislation.govt.nz developer API](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/)**.

It lets an MCP client such as Claude search New Zealand legislation, browse
every point-in-time version of an Act, Bill, or piece of secondary legislation,
and read the text of a single section or schedule, all through the official
API published by the Parliamentary Counsel Office (PCO).

Written in TypeScript on the official MCP SDK. It runs over stdio for local
clients (Claude Desktop, Claude Code, Cursor, and any other MCP client) or over
streamable HTTP, with its own login, for claude.ai custom connectors.

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

`get_legislation_text` with the `work_id`, `as_at: "2015-06-30"` and a
`section` or `schedule` reads the version in force on that date. To choose a
version yourself, `list_versions` lists every version with its effective date;
pass the chosen `version_id` instead.

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

Takes a `version_id`, or a `work_id` with an optional `as_at` date (see
below). Returns `parts[]` with their subparts and sections, any sections
outside a Part, and `schedules[]`. Entries that are not current carry a
`status` such as `repealed` or `struck_out`. Provisions and schedules quoted
inside amending provisions are not listed. Needs the XML format, which all
PCO-published documents have.

#### `get_legislation_text`

| Parameter | Notes |
| --- | --- |
| `version_id` or `work_id` | One is required. A `work_id` resolves to the newest version dated on or before today (NZ time), so a future-dated version is never served as current law. |
| `as_at` | With `work_id`: a date (`YYYY-MM-DD`). Reads the newest version dated on or before it, i.e. the law as it stood then. |
| `section` | A section number such as `"22"` or `"25A"`. Returns only that provision with its Part and subpart. |
| `schedule` | A schedule number such as `"1"`. |
| `format` | `pdf` returns the PDF download URL instead of text. `pdf_original_scan` returns the scan of the original printed Act, which only as-enacted versions of pre-2008 Acts have. |
| `max_chars` | Truncates whole-document output (default 100,000 characters). Not applied to a single section or schedule. |
| `exclude` | Content types to strip: `cover`, `history_notes`, `comparative_references`, `editorial_notes`, `defined_term_links`, `end_matter`. Everything is kept by default. |

A section or schedule lookup only matches the document's own provisions. Text
quoted inside an amending provision (a "new section 40" being inserted into
another Act, say) is never returned in place of the Act's own section 40. Where
a number is genuinely shared, as when a repealed section's number is reused,
the current provision is returned with `other_matches` and a plain-English
`warning`. A provision that is not current carries `status` (`repealed`,
`not_in_force`, `struck_out`, ...). An amendment paper has no provisions of its
own, so asking one for a section explains that rather than reporting "not
found".

Every response names the version read (`version_id`, `version_date`) and how it
was chosen (`selected_by`: `as_at` or `latest_current`). For Acts and
regulations, `document_as_at` is the as-at date the fetched document itself
declares, an independent check on the version. A document that does not match
the version asked for is refused.

Text comes from the official XML format, which carries the document structure.
The HTML format is only a fallback, because it is the full website page. The
table of contents is always dropped, since `list_sections` covers it better.

Each table row is one line, with cells separated by ` | ` and paragraphs
inside a cell by ` / `. Blank or spanned cells keep an empty slot, so every
cell stays under its column heading (`| | Support for Walking Access | 3,595`).
A literal `|` in cell text is escaped as `\|`. Footnotes appear inline as
`[footnote: …]`, and text a bill strikes out as `[deleted: …]`.

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

The server can also run as an HTTP service for claude.ai custom connectors:

```bash
npm run start:http
```

It serves the MCP streamable HTTP transport at `http://127.0.0.1:8091/mcp`
(override with `LEGISLATION_HTTP_HOST` and `LEGISLATION_HTTP_PORT`). Requests
to `/mcp` need a login: see [Self-hosting with a login](#self-hosting-with-a-login).
For local testing without a login, set `LEGISLATION_AUTH=off`; the server then
listens on 127.0.0.1 only.

### Self-hosting with a login

The HTTP server is its own OAuth 2.1 authorisation server. When you add it to
claude.ai as a custom connector, claude.ai opens this server's login page; you
sign in once with your own username and password, and claude.ai then holds a
token for that login. Only the people listed in `LEGISLATION_AUTH_USERS` can
sign in. Someone else who finds the URL gets the same login page and no
further.

**1. Set up `.env`** on the server, next to `compose.yaml`:

```bash
cp .env.example .env
```

Set `LEGISLATION_NZ_API_KEY`, and `LEGISLATION_PUBLIC_URL` to the address the
server will be reached at (e.g. `https://legislation.example.nz`, origin only).

The server is reached only through a Cloudflare Tunnel run by the `cloudflared`
service in `compose.yaml`; nothing is published on the host. In the Cloudflare
dashboard, under Zero Trust → Networks → Tunnels, create a tunnel (connector
type Cloudflared), copy the token from its install command (the long string
after `--token`) into `CLOUDFLARE_TUNNEL_TOKEN`, and add a public hostname
(`legislation.example.nz`) whose service is `http://legislation-mcp:8091`.

**2. Add a user** for each person. This asks for the password twice without
showing it, and prints a line with a scrypt hash of it (never the password):

```bash
docker compose run --rm legislation-mcp node dist/auth/cli.js hash-password carolina
```

Put the printed lines in `.env`, comma-separated:

```
LEGISLATION_AUTH_USERS=carolina:scrypt.32768.8.1....,khai:scrypt.32768.8.1....
```

Passwords need at least 12 characters. Each person should choose their own and
run the command themselves, or type it in when you run it.

**3. Start it:**

```bash
docker compose up -d --build
```

`cloudflared` starts once the server reports healthy. Check it with
`curl https://legislation.example.nz/healthz`.

Leave Cloudflare Access off for this hostname (the server has its own login),
and make sure no bot or browser challenge applies to it (Bot Fight Mode,
Browser Integrity Check, Under Attack mode, or a challenge rule): claude.ai's
servers call `/register`, `/token` and `/mcp` directly and cannot answer one.

**4. Connect claude.ai.** In claude.ai, open Settings → Connectors → Add custom
connector and enter `https://legislation.example.nz/mcp`. A login window
opens; sign in with your username and password. Each person does this in their
own claude.ai account.

**Removing someone or changing a password.** Delete their entry from
`LEGISLATION_AUTH_USERS` (or replace its hash), then
`docker compose up -d`. Their logins stop working on their next request.

**How long a login lasts.** Access tokens last an hour and are renewed
silently. A login ends after 30 days without use, or when revoked. Tokens are
rotated on every renewal, and if an old token is ever presented again the
whole login is revoked, since someone else must hold a copy.

**What else protects it.**

- Clients may only register claude.ai's own callback addresses
  (`LEGISLATION_AUTH_REDIRECT_ALLOWLIST` to change), so another site cannot
  trick you into logging in on its behalf.
- Five wrong passwords in 15 minutes lock that username for 15 minutes;
  twenty lock the visitor's IP (read from Cloudflare's `CF-Connecting-IP`).
- No port is published on the host: the only way in is the tunnel.
- Each person may make 4,000 upstream API requests per NZ day
  (`LEGISLATION_DAILY_CAP_PER_USER`), so one runaway chat cannot exhaust the
  key's 10,000.
- Only hashes of tokens are stored, in `/data/auth-state.json` on a Docker
  volume. The container has a read-only filesystem, drops all capabilities,
  and runs as an unprivileged user.

**Usage log.** Each tool call is logged as one line of JSON: who, which tool,
which document and section, whether it succeeded, how many upstream requests
it made, and how long it took. Search terms, legislation text, keys and
tokens are never logged. Logins, failed logins and lockouts are logged too.

```bash
docker compose logs -f legislation-mcp
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `LEGISLATION_NZ_API_KEY` | Yes | Key for the JSON API (10,000 requests/day). |
| `LEGISLATION_NZ_RSS_API_KEY` | No | RSS-only key for the two feed tools (1,500 requests/day). |
| `LEGISLATION_HTTP_HOST` | No | Bind address for the HTTP transport (default `127.0.0.1`; `0.0.0.0` in Docker). |
| `LEGISLATION_HTTP_PORT` | No | Port for the HTTP transport (default `8091`). |
| `LEGISLATION_PUBLIC_URL` | HTTP | The address the HTTP server is reached at; the OAuth issuer. |
| `LEGISLATION_AUTH_USERS` | HTTP | `user:hash` pairs, comma-separated (see above). |
| `LEGISLATION_DAILY_CAP_PER_USER` | No | Upstream API requests per person per NZ day (default 4,000; 0 for no cap). |
| `LEGISLATION_AUTH_REDIRECT_ALLOWLIST` | No | Redirect URIs clients may register (default: claude.ai's callbacks). |
| `LEGISLATION_AUTH_STATE` | No | Login state file (default `data/auth-state.json`; `/data/auth-state.json` in Docker). |
| `LEGISLATION_AUTH` | No | `off` runs the HTTP server without a login, on 127.0.0.1 only. For local testing. |

## How it works

- **Search and metadata** come from the JSON API at
  `https://api.legislation.govt.nz/v0/`.
- **Document text** is fetched from the `formats[].url` links a version
  advertises. The XML format is parsed to find a section by its label inside
  the main body only, so schedule provisions with the same number never
  collide, and to walk up to the enclosing Part and subpart. Anything inside
  `<amend>` (quoted text in Acts, bills and regulations), `<instrument.amend>`
  (amendment papers) or the end-matter `<skeletons>` of other Acts is not the
  document's own and is ignored.
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

Transient upstream errors (502, 503, 504) and timeouts are retried up to three
times with capped backoff. Each attempt times out after 30 seconds, and a
request gives up once 60 seconds have passed in all, so a dead upstream fails
before the MCP client gives up on the tool call. A 429 is not retried: it means the daily quota is spent until
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

11. **Quoted provisions are marked up like real ones.** A provision being
    inserted into another Act is a full `<prov>` (with Parts, subparts and
    schedules as needed) inside `<amend>`, so a search for every `<prov>` with
    a given label finds quoted provisions too, and they can come before the
    Act's own provision of the same number (section 40 of the Statutes
    Amendment Act 2025, for example). Amendment papers wrap theirs in
    `<instrument.amend>`. Verified October 2026.

12. **Section numbers are reused.** The Crimes Act 1961 has two sections 253
    and 254: the ones repealed in 2011 (`deletion-status="repealed"`) and new
    ones inserted later. Bills carry a clause the committee struck out
    (`amend.level1="struckout-cowh"`) next to the clause that replaced it, with
    the same number.

13. **The newest version's format URLs say `latest`, not its date**
    (`.../en/latest.xml`); older versions' URLs carry their date. Acts and
    regulations declare their as-at date on the root element
    (`date.as.at`), which the server checks against the version requested.

## Development

```bash
npm run build      # compile to dist/
npm run dev        # compile on change
npm run typecheck  # type-check without emitting
npm start          # run the stdio server
npm run start:http # run the HTTP server
npm test           # build, then run the test suite (node:test; offline, no key)
```

The tests cover section and schedule lookup against trimmed excerpts of real
PCO XML (`test/fixtures/`), version selection by date, upstream timeouts, and
the HTTP server's login end to end. They make no requests to the legislation
API.

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
├─ http.ts              # streamable HTTP entry point, with login (Express)
├─ usage.ts             # per-request user context and per-person daily cap
├─ log.ts               # one-line JSON event log on stderr
├─ server.ts            # transport-independent server factory; registers all tools
├─ client.ts            # HTTP client: auth, retries, rate-limit headers, feed fetching
├─ types.ts             # API response types (confirmed against live responses)
├─ util.ts              # response envelope, version dates, website URLs, ephemeral ids
├─ format.ts            # HTML → plain text
├─ xml.ts               # XML parsing and document-structure extraction
├─ feed.ts              # Atom feed parsing for the legacy /api/rss/ endpoints
├─ auth/
│  ├─ config.ts         # login settings from the environment
│  ├─ provider.ts       # OAuth provider: login, codes, tokens, revocation
│  ├─ store.ts          # state file: clients, logins, token hashes, usage
│  ├─ passwords.ts      # scrypt password hashes
│  ├─ lockout.ts        # wrong-password lockouts
│  ├─ loginPage.ts      # the login page
│  └─ cli.ts            # hash-password command
└─ tools/
   ├─ search.ts         # search_legislation
   ├─ versions.ts       # list_versions
   ├─ versionDetails.ts # get_version_details
   ├─ listSections.ts   # list_sections
   ├─ getText.ts        # get_legislation_text
   ├─ searchRss.ts      # search_legislation_rss
   ├─ versionsRss.ts    # list_versions_rss
   ├─ rateLimit.ts      # get_rate_limit_status
   └─ resolve.ts        # work_id (+ as_at) → version_id
```

## License

MIT
