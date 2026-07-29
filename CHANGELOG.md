# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
