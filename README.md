# legislation-nz-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
**New Zealand [legislation.govt.nz developer API](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/)**.
It exposes the API as tools an MCP client (such as Claude) can call: search
legislation, browse point-in-time versions, and read the text of acts, bills,
and secondary legislation.

Written in TypeScript on the official MCP SDK. It runs over stdio for local
clients (Claude Desktop, Claude Code) or over streamable HTTP as a standalone
localhost service.

## Tools

| Tool | Description |
| --- | --- |
| `search_legislation` | Search by title or full-text content, with filters (type, status, classification, agency, publisher) plus sorting and pagination. Returns matching works and their newest matching version id. |
| `list_versions` | List all point-in-time versions of a work (by `work_id`). |
| `get_version_details` | Metadata for one version, including available formats (html/pdf/xml) and their URLs. |
| `list_sections` | List a document's structure: Parts, subparts, section numbers and headings, and schedules. Use it to find a section or schedule number before calling `get_legislation_text`. |
| `get_legislation_text` | Read a document's text. Takes a `version_id` or `work_id`. Without `section`/`schedule`, returns the whole document; with `section:"22"` or `schedule:"1"`, returns just that provision with its Part/subpart context. |

A typical flow is `search_legislation` → `list_sections` → `get_legislation_text`
with a `section` argument.

## Setup

Requires Node.js 18 or later and an API key. Request a key on the
[developer API page](https://www.legislation.govt.nz/learn-more/legislation-data/developer-api/).

```bash
npm install
npm run build
```

Provide the API key via a `.env` file in the project root (recommended) — the
server loads it automatically at startup, so the key stays out of your shell
environment and out of the MCP client config:

```bash
cp .env.example .env
# then edit .env and set LEGISLATION_NZ_API_KEY=...
```

`.env` is gitignored. A `LEGISLATION_NZ_API_KEY` already set in the environment
(for example via an MCP client `env` block) takes precedence over the `.env`
file, so you can use whichever approach suits your setup — a `.env` file, an
`env` block in the client config, or a shell `export`.

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

### Run over HTTP

For remote use, the server can run as its own localhost HTTP service (for
example behind a reverse proxy or gateway that handles authentication):

```bash
npm run start:http
```

It binds to `127.0.0.1:8091` by default; override with `LEGISLATION_HTTP_HOST`
and `LEGISLATION_HTTP_PORT`. The HTTP entry point has no authentication of its
own — it is designed to sit behind a trusted front end and must not be exposed
on a public interface.

## API notes

- **Base URL:** `https://api.legislation.govt.nz`
- **Auth:** `X-Api-Key` header (handled by the client).
- **Rate limits:** 10,000 requests/day per key; 2,000 requests per 5 minutes per
  IP. The client retries transient throttling (429/503) with backoff.
- The API returns document **metadata**; the text itself lives behind the
  `formats[].url` links, which `get_legislation_text` fetches and cleans.

### Observed API behaviour

The following notes record places where the live `/v0/` API behaves differently
from what the published documentation implies. Each one affected the client
implementation and may be useful to others building against the same API.
Behaviour was verified against live responses (Privacy Act 2020,
`work_id=act_public_2020_31`); confirm against the canonical documentation
before relying on any point.

1. **List responses use a `results` envelope, not a bare array.** Search and
   version listings return an object —
   `{ "results": [ ... ], "total": N, "page": N, "per_page": N }` — for both
   `GET /v0/works/` and `GET /v0/works/{work_id}/versions/`. Code expecting a
   top-level array (or a `works`/`versions` key) receives zero results.

2. **`title` is on the version, not the work.** In `GET /v0/works/` results, a
   work has no top-level `title`; the human-readable title appears only in
   `latest_matching_version.title`.

3. **Versions carry no discrete date field.** The effective date is encoded in
   the trailing segment of `version_id`
   (e.g. `act_public_2020_31_en_2026-05-01` → `2026-05-01`) and must be parsed
   from the id.

4. **`administering_agencies` is a string filter but an array in responses.**
   As a request filter it is a single agency name; in responses the field is a
   JSON array (e.g. `["Ministry of Justice"]`).

5. **The `html` format URL returns the full website page.** A version's
   `formats[]` lists `html`, `pdf`, and `xml`. The `html` URL serves the
   complete legislation.govt.nz web page (navigation, menus, headers/footers),
   not the content alone. The `xml` format is the clean, machine-readable
   content — `get_legislation_text` uses it by default.

6. **Identifiers are not zero-padded.** Observed ids are `act_public_2020_31`,
   not `act_public_2020_0031`. Version ids follow
   `work_id + "_" + language + "_" + ISO-date`
   (e.g. `act_public_2020_31_en_2026-05-01`).

## Future work

- **Caching.** An in-memory or on-disk cache for document fetches and version
  lists would reduce calls against the daily quota for repeated reads of the
  same work.
- **Change monitoring.** A "notify me of changes" feature could poll the `/v0/`
  endpoints and diff versions. (The API also offers legacy RSS endpoints, but
  the JSON endpoints are a superset and are preferred for on-demand querying.)

## Project layout

```
src/
├─ index.ts             # stdio entry point (Claude Desktop / Claude Code)
├─ http.ts              # streamable HTTP entry point (localhost service)
├─ server.ts            # transport-independent server factory; registers all tools
├─ client.ts            # HTTP client: auth, retries, rate-limit handling
├─ types.ts             # API response types (confirmed against live responses)
├─ util.ts              # response-envelope and version_id helpers
├─ format.ts            # HTML → plain text
├─ xml.ts               # XML parsing and document-structure extraction
└─ tools/
   ├─ search.ts         # search_legislation
   ├─ versions.ts       # list_versions
   ├─ versionDetails.ts # get_version_details
   ├─ listSections.ts   # list_sections
   ├─ getText.ts        # get_legislation_text
   └─ resolve.ts        # work_id → newest version_id helper
```

## License

MIT
