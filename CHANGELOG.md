# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Stateless MCP (spec `2026-07-28`).** Migrated from `@modelcontextprotocol/sdk`
  v1 to the v2 packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`).
  HTTP mode now uses `createMcpHandler`: no `initialize` handshake, no
  `Mcp-Session-Id`, every request is self-describing (`_meta` envelope plus
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers) so any instance behind a
  plain load balancer can answer any request. `2025-11-25`-era clients that still send
  `initialize` are served per request from the same endpoint. stdio uses `serveStdio`,
  which pins each connection's era from its opening message. Requires **Node.js 20+**.

### Added
- Verifiable writes. `redmine_update_issue`, `redmine_create_issue`, and
  `redmine_add_issue_note` now re-read from Redmine after writing and return the
  resulting issue (or the recorded note), instead of assuming success — a PUT
  returns 204 No Content, so a failed or no-op update previously still looked like
  it worked. `create` also returns the new id and a direct url. (#158273)

### Fixed
- Issue creates from LLM clients no longer fail with a wall of unrelated 422 errors
  ("Priority cannot be blank", "Category is not included in the list", "Parent task
  is invalid", ...). Models routinely fill optional ids with `0`/`""`; those are now
  stripped from create/update bodies before they reach Redmine, matching what the
  query path already did.
- Enum names resolve on the leading word(s) when an instance decorates them
  (`"Normal"` -> `"Normal - Minor"`), and an unknown status/priority/tracker name is
  rejected up front with the list of valid names instead of being forwarded and
  surfacing later as a misleading "cannot be blank".
- Projects with required custom fields (e.g. `"Is Billable (EH)?"`) can now be
  written to: `redmine_create_issue` / `redmine_update_issue` accept
  `custom_fields` keyed by field name or id, and a create rejected for a blank
  required custom field says exactly which field to pass (with its allowed values
  when the key is an admin).

- Redmine validation failures (HTTP 422) are surfaced with Redmine's exact reason
  (e.g. "Subject cannot be blank") instead of a bare status code, so rejected
  updates/creates report *why* they failed. (#158273)

- Friendly date and column mapping for `redmine_list_issues`. New `created_on`
  and `updated_on` filters accept a plain date (`2026-08-03` = that whole day), a
  `from|to` range, or an operator (`>=2026-08-01`) and are normalized to Redmine's
  query syntax automatically, plus new `category_id` and `done_ratio` filters.
  Tool and server descriptions now map everyday words (created/opened/added ->
  created_on, modified/changed/updated -> updated_on, etc.) so callers no longer
  have to guess the "magic" filter name. (#158064)

- Accurate counting and full pagination for `redmine_list_issues`. Results are now
  a summary object whose `total_count` is the true number of matching issues (not
  the length of one page), with `count`/`has_more` so a caller can tell when more
  matched than were returned. A new `fetch_all: true` pages through every match
  (up to 1000) in one call, and `detail: "summary"|"full"` controls whether issues
  are compact (key columns + set custom fields) or raw. Fixes counts like "how many
  tickets were created on 8/3" returning a page size (50) instead of the real total
  (79). (#158063)

- Streamable HTTP transport: run `node index.js --http` (or set `MCP_HTTP_PORT`/`PORT`)
  to serve MCP over HTTP at `/mcp` in addition to the default stdio transport.
  `MCP_HTTP_HOST` (default `127.0.0.1`) and `MCP_ALLOWED_HOSTS` (DNS-rebinding
  protection) tune the listener.
- Per-request credentials: an `Authorization: Bearer <redmine-api-key>` header on an
  HTTP request **overrides** `REDMINE_API_KEY` for that request, so a single server
  process can serve many users, each acting as themselves. `REDMINE_API_KEY` is now
  optional; a call fails only when neither a bearer token nor the env key is available.
- Identity headers: an incoming request header can set the impersonation identity from
  the transport layer. The accepted headers are configurable and ordered via
  `REDMINE_USER_HEADERS` (default `x-redmine-user`, `x-redmine-on-behalf-of`,
  `x-on-behalf-of`, `x-ozwell-user-name`) — the first one present on the request wins,
  so a platform-injected header such as `X-Ozwell-User-Name` is mapped to Redmine's
  `X-Redmine-Switch-User` automatically while an explicit `X-Redmine-User` still
  overrides it. A header identity overrides the `on_behalf_of` tool argument and
  `REDMINE_ON_BEHALF_OF`, and — like `REDMINE_LOCK_ON_BEHALF_OF` — hides the argument
  from `tools/list` so the model cannot choose or drop the identity.
- `systemd/redmine-mcp.service` and `systemd/redmine-mcp.env.example` for running the
  HTTP transport as a hardened system service that starts on boot.
- User impersonation ("user assertion"): every tool accepts an optional
  `on_behalf_of` argument (Redmine login or email), and a `REDMINE_ON_BEHALF_OF`
  env var provides a default. When the configured API key is an admin key, requests
  are sent with the `X-Redmine-Switch-User` header so actions are attributed to the
  target user; emails are resolved to the matching login automatically. Non-admin
  keys ignore the argument, so existing setups are unaffected.
- `REDMINE_LOCK_ON_BEHALF_OF` env flag to lock impersonation to `REDMINE_ON_BEHALF_OF`
  and disable the caller-supplied `on_behalf_of` argument — the recommended hardening
  for shared-admin-key deployments so a model cannot choose or drop the identity.
- Fail-closed protection for admin keys: tool calls made with an admin key and no
  impersonation identity are now refused by default. Set `REDMINE_ALLOW_ADMIN=1` to
  intentionally act as the admin key owner. Non-admin keys are unaffected.
- Audit logging: one `key=value` line per HTTP request and per tool call on stderr
  (the journal under systemd), recording who — the resolved Redmine login, how the
  identity was decided (`pinned`/`arg`/`key-owner`), and a SHA-256 tag of the API key
  rather than the key itself — and where — peer address, the first `X-Forwarded-For`
  hop logged alongside it (never instead of it, since a direct client can forge it),
  and user agent — plus the tool name, duration and outcome. Tool arguments are never
  logged, and header-derived values are newline-stripped and length-capped to prevent
  log forging. Set `MCP_LOG_REQUESTS=0` to disable.

## [0.1.0] - 2026-04-24

### Added
- Initial Redmine MCP server implementation.
- Tools: `redmine_current_user`, `redmine_list_projects`, `redmine_get_project`,
  `redmine_list_issues`, `redmine_get_issue`, `redmine_create_issue`,
  `redmine_update_issue`, `redmine_add_issue_note`, `redmine_list_users`,
  `redmine_search`, `redmine_list_time_entries`, `redmine_create_time_entry`.
- Stdio transport via `@modelcontextprotocol/sdk`.
- Configuration via `REDMINE_URL` and `REDMINE_API_KEY` environment variables.
