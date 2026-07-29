# redmine-mcp

> A [Model Context Protocol](https://modelcontextprotocol.io) server that turns [Redmine](https://www.redmine.org/) into a first-class tool for AI agents.

[![CI](https://github.com/mieweb/redmine-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mieweb/redmine-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E56CF)](https://modelcontextprotocol.io)
[![Redmine](https://img.shields.io/badge/Redmine-REST%20API-B32024?logo=redmine&logoColor=white)](https://www.redmine.org/projects/redmine/wiki/Rest_api)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Ask your editor's AI to *"summarize Redmine #12345"*, *"list my open tickets"*, or *"log 30 minutes to issue 9001"* — and let it actually do it.

---

## ✨ Features

- 🔎 **Search & browse** projects, issues, and users
- 📝 **Create, update, and comment** on issues from your AI client
- ⏱️ **Log time entries** against issues or projects
- 🔐 **API-key auth** — from the environment, or per-request `Authorization: Bearer` in HTTP mode
- 📦 **Zero config beyond two env vars** — one file, no database
- 🔌 **stdio *and* Streamable HTTP** transports — run it locally or host it for a team
- 🧩 Works with **any MCP-compatible client**: VS Code, Claude Desktop, Cursor, Windsurf, Zed, …

## 🧰 Tools

| Tool | Description |
| --- | --- |
| `redmine_current_user` | Return the user that owns the API key (useful for sanity checks) |
| `redmine_list_projects` | List visible projects |
| `redmine_get_project` | Get one project by id or identifier |
| `redmine_list_issues` | Search/filter issues (project, assignee, status, sort, …) |
| `redmine_get_issue` | Fetch one issue with journals, attachments, children, relations |
| `redmine_create_issue` | Create a new issue |
| `redmine_update_issue` | Update any field on an existing issue |
| `redmine_add_issue_note` | Add a comment (journal note), optionally private |
| `redmine_list_users` | List users (admin) or filter by name/status |
| `redmine_search` | Full-text search across issues, wiki, news, documents |
| `redmine_list_time_entries` | List time entries with filters |
| `redmine_create_time_entry` | Log time against an issue or project |
| `redmine_list_issue_attachments` | List attachments on an issue (id, filename, content-type, size) |
| `redmine_get_attachment` | Download an attachment by id — **images are returned inline as MCP image content** so the model can view them; other files are returned as base64 and optionally written to disk via `save_to` |

## 🚀 Installation

### Prerequisites

- **Node.js 18+**
- A Redmine instance reachable from your machine
- A Redmine **API key** (get it from *My account → API access key* in Redmine)

### Option A — Run directly from GitHub (no install)

The simplest way. Your MCP client downloads and runs it on demand via `npx`:

```jsonc
{
  "servers": {
    "redmine": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:mieweb/redmine-mcp"],
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "your-redmine-api-key"
      }
    }
  }
}
```

### Option B — Install from npm

```bash
npm install -g @mieweb/redmine-mcp
```

Then reference the installed binary:

```jsonc
{
  "servers": {
    "redmine": {
      "type": "stdio",
      "command": "redmine-mcp",
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "your-redmine-api-key"
      }
    }
  }
}
```

### Option C — Clone and run locally (for hacking on it)

```bash
git clone https://github.com/mieweb/redmine-mcp.git
cd redmine-mcp
npm install
```

```jsonc
{
  "servers": {
    "redmine": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/redmine-mcp/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "your-redmine-api-key"
      }
    }
  }
}
```

## 🧑‍💻 Client setup

### VS Code (GitHub Copilot)

Add the JSON snippet above to your user-scope `mcp.json`:

- **Linux:** `~/.vscode-server/data/User/mcp.json` (remote) or `~/.config/Code/User/mcp.json`
- **macOS:** `~/Library/Application Support/Code/User/mcp.json`
- **Windows:** `%APPDATA%\Code\User\mcp.json`

Then open the **Chat** view and start asking Copilot about your Redmine data.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "npx",
      "args": ["-y", "github:mieweb/redmine-mcp"],
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "your-redmine-api-key"
      }
    }
  }
}
```

### Cursor / Windsurf / Zed

All three read a similar `mcpServers` or `servers` block. Use the same config shape as above and point it at `npx github:mieweb/redmine-mcp`.

## ⚙️ Configuration

| Variable | Required | Description |
| --- | :---: | --- |
| `REDMINE_URL` | ✅ | Base URL of your Redmine instance, e.g. `https://redmine.example.com`. Trailing slashes are OK. |
| `REDMINE_API_KEY` | ⬜* | Personal or service-account API key. Treat it like a password. *Required unless every request supplies an `Authorization: Bearer <key>` header (HTTP mode).* |
| `MCP_HTTP_PORT` / `PORT` | ⬜ | Port for the Streamable HTTP transport. Setting either implies `--http`. Default `3000`. |
| `MCP_HTTP_HOST` | ⬜ | Bind address in HTTP mode. Default `127.0.0.1`. |
| `MCP_ALLOWED_HOSTS` | ⬜ | Comma-separated `Host` header allow-list. When set, DNS-rebinding protection is enabled. |
| `REDMINE_ON_BEHALF_OF` | ⬜ | Default user to act on behalf of — a Redmine **login or email**. Requires `REDMINE_API_KEY` to be an **admin** key. Used as the fallback when a tool call doesn't pass its own `on_behalf_of`. Ignored for non-admin keys. |
| `REDMINE_LOCK_ON_BEHALF_OF` | ⬜ | When truthy (`1`/`true`/`yes`), **locks** the identity to `REDMINE_ON_BEHALF_OF`: the per-call `on_behalf_of` argument is not advertised and is ignored, so the model cannot impersonate a different user. Use for shared-admin deployments (see Security). |
| `REDMINE_ALLOW_ADMIN` | ⬜ | When truthy (`1`/`true`/`yes`), allows tool calls to run as the admin key owner when no impersonation identity is in effect. By default this is **fail-closed**: an admin key with no resolved identity is refused instead of silently acting with full admin privileges. |

The key is sent as the `X-Redmine-API-Key` header on every request.

### 🌐 HTTP transport

By default the server speaks MCP over **stdio**. Pass `--http` (or set `MCP_HTTP_PORT`/`PORT`)
to serve the **Streamable HTTP** transport instead:

```bash
REDMINE_URL=https://redmine.example.com MCP_HTTP_PORT=3000 npx -y github:mieweb/redmine-mcp --http
```

The endpoint is `http://<host>:<port>/mcp`. Each request may carry its own Redmine
credential and identity:

```http
POST /mcp
Authorization: Bearer <redmine-api-key>
X-Redmine-On-Behalf-Of: jdoe@example.com
```

**A request bearer token overrides `REDMINE_API_KEY`.** When no bearer token is
present the env key is used; if neither is available the tool call fails with a
clear error. Requests are handled statelessly — one MCP server instance per
request — so concurrent callers with different tokens never share state, and
caches (admin status, name→id lookups) are scoped per credential.

**`X-Redmine-On-Behalf-Of` sets the impersonation identity** (login or email) for that
request, overriding the `on_behalf_of` tool argument and `REDMINE_ON_BEHALF_OF`. Because
it comes from the transport rather than the model, the `on_behalf_of` argument is then
hidden from `tools/list` and ignored — the same hardening `REDMINE_LOCK_ON_BEHALF_OF`
gives stdio deployments. This is the recommended way to front a shared admin key with
an authenticating proxy that injects the end user's identity.

```jsonc
{
  "servers": {
    "redmine": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer your-redmine-api-key" }
    }
  }
}
```

### 🐧 Run as a service (systemd)

[`systemd/redmine-mcp.service`](systemd/redmine-mcp.service) starts the HTTP transport
on boot and restarts it on failure. Install it:

```bash
# 1. Code + a dedicated unprivileged user
sudo git clone https://github.com/mieweb/redmine-mcp.git /opt/redmine-mcp
sudo npm --prefix /opt/redmine-mcp ci --omit=dev
sudo useradd --system --no-create-home --shell /usr/sbin/nologin redmine-mcp

# 2. Configuration (contains the API key — keep it root-owned)
sudo cp /opt/redmine-mcp/systemd/redmine-mcp.env.example /etc/redmine-mcp.env
sudo chown root:redmine-mcp /etc/redmine-mcp.env
sudo chmod 0640 /etc/redmine-mcp.env
sudo editor /etc/redmine-mcp.env

# 3. Unit
sudo cp /opt/redmine-mcp/systemd/redmine-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now redmine-mcp
```

Check it:

```bash
systemctl status redmine-mcp
journalctl -u redmine-mcp -f
```

Adjust `ExecStart` if `node` isn't at `/usr/bin/node` (`command -v node`), or if you
installed from npm instead — then use `ExecStart=/usr/bin/redmine-mcp --http`.

> The unit binds to `127.0.0.1` by default. To serve other machines, terminate TLS at
> a reverse proxy in front of it rather than exposing the port directly, and set
> `MCP_ALLOWED_HOSTS`. Ports below 1024 additionally need
> `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the unit.

### 👥 User impersonation ("user assertion")

If you run a shared **admin** API key but want each action attributed to the
actual end user, use impersonation. Every tool accepts an optional `on_behalf_of`
argument (a Redmine **login or email**); the AI supplies the currently logged-in
user per request. When the key is an admin key, the server resolves the value to a
login and sends Redmine's `X-Redmine-Switch-User` header so the action is recorded
as that user. Emails are resolved to the matching login automatically.

The identity is taken from the first of these that is set:

1. `REDMINE_ON_BEHALF_OF`, when `REDMINE_LOCK_ON_BEHALF_OF` is truthy
2. the `X-Redmine-On-Behalf-Of` request header (HTTP transport)
3. the `on_behalf_of` tool argument
4. `REDMINE_ON_BEHALF_OF` as a plain default

Sources 1 and 2 come from outside the model, so they also hide `on_behalf_of` from
`tools/list` and ignore it if sent.

```jsonc
{
  "servers": {
    "redmine": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:mieweb/redmine-mcp"],
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "an-admin-api-key"
      }
    }
  }
}
```

Then the client can call, e.g., `redmine_add_issue_note` with
`{ "id": 12345, "notes": "…", "on_behalf_of": "jdoe@example.com" }`.

This is fully backward compatible:

- **Non-admin keys** (typical personal setups) ignore `on_behalf_of` entirely and
  behave exactly as before — no configuration change needed.
- Omitting `on_behalf_of` (and `REDMINE_ON_BEHALF_OF`) acts as the API key's own user.
- Set `REDMINE_ON_BEHALF_OF` to impersonate a fixed user by default without
  passing the argument on every call.

> ⚠️ **`on_behalf_of` is an assertion, not authentication.** The server trusts the
> identity it is given. With an **admin** key, whoever controls the argument can act
> as *any* user (including admins). See [Security](#-security) for how to deploy this
> safely.

## 💡 Example prompts

Once wired up, try asking your AI:

- *"Show me my open Redmine tickets, sorted by recent updates."*
- *"Summarize issue 153285 and list what the last three comments asked for."*
- *"Create a bug report in project `webchart` titled 'Login loop on iOS 26', priority high."*
- *"Post a comment on #12345 saying the fix is deployed to DEV."*
- *"How many hours did I log this week across all projects?"*
- *"Log 45 minutes to issue 9001 with the comment 'pairing with Aris'."*

## 🔐 Security

- The server is **stdio-only by default**; it opens a port only when you start it with `--http`.
- In HTTP mode it binds to `127.0.0.1` unless you set `MCP_HTTP_HOST`. Expose it publicly
  only behind TLS and an authenticating reverse proxy, and set `MCP_ALLOWED_HOSTS` to
  enable DNS-rebinding protection.
- A per-request `Authorization: Bearer <key>` is the preferred way to serve multiple
  users from one process: each request acts as the key owner, so no shared admin key
  is needed.
- Your API key is read from the environment at startup — never hard-code it into a repository.
- Rotate the key immediately in Redmine if it is ever exposed.
- See [SECURITY.md](SECURITY.md) for responsible-disclosure contact info.

### Impersonation trust model

`on_behalf_of` is a **user assertion** — the server trusts the identity supplied by
the caller; it does **not** verify it. The safety of impersonation therefore depends
entirely on the API key and how the identity is supplied:

- **Personal / non-admin key** (e.g. an individual developer's key): impersonation
  is impossible — Redmine ignores the switch-user header, so `on_behalf_of` is inert.
  This is the safest and recommended setup for per-developer clients.
- **Shared admin key**: whoever controls the `on_behalf_of` value can act as *any*
  user, including administrators. Because MCP tool arguments are chosen by the model,
  a compromised or prompt-injected model could pick a different identity or omit it
  (falling back to full admin). **Do not let the model choose the identity when using
  an admin key.** Supply it out-of-band instead — via `REDMINE_LOCK_ON_BEHALF_OF`
  (stdio) or the `X-Redmine-On-Behalf-Of` header injected by a trusted proxy (HTTP).
  If clients can set that header themselves, it is no stronger than the tool argument.

**Deploying an admin key safely (one server per authenticated session):**

1. Have your application (not the model) spawn a redmine-mcp process per logged-in
   session and set `REDMINE_ON_BEHALF_OF` to that session's verified user.
2. Set `REDMINE_LOCK_ON_BEHALF_OF=1`. This removes the `on_behalf_of` argument from
   the advertised tools and ignores any caller-supplied value, so the model cannot
   change or drop the identity — every request is bound to the session user.

```jsonc
{
  "env": {
    "REDMINE_URL": "https://redmine.example.com",
    "REDMINE_API_KEY": "an-admin-api-key",
    "REDMINE_ON_BEHALF_OF": "jdoe@example.com",
    "REDMINE_LOCK_ON_BEHALF_OF": "1"
  }
}
```

Without the lock, treat any admin-key deployment as trusting the model with full
administrative authority.

### Fail-closed on unattributed admin access

By default the server **refuses** any tool call made with an admin key when no
impersonation identity is in effect (no lock identity, no `REDMINE_ON_BEHALF_OF`,
and no per-call `on_behalf_of`). This prevents a misconfigured shared-admin
deployment from silently executing actions with full admin privileges. To
intentionally operate as the admin account itself, set `REDMINE_ALLOW_ADMIN=1`.
Non-admin keys are unaffected.

## 🛠️ Development

```bash
npm install
REDMINE_URL=https://your-redmine \
REDMINE_API_KEY=xxxx \
node index.js
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

[MIT](LICENSE) © [MIE (Medical Informatics Engineering)](https://mieweb.com)
