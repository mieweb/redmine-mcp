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
- 🔐 **API-key auth** only — your credentials never leave the machine
- 📦 **Zero config beyond two env vars** — one file, stdio transport, no database
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
| `REDMINE_API_KEY` | ✅ | Personal or service-account API key. Treat it like a password. |
| `REDMINE_ON_BEHALF_OF` | ⬜ | Default user to act on behalf of — a Redmine **login or email**. Requires `REDMINE_API_KEY` to be an **admin** key. Used as the fallback when a tool call doesn't pass its own `on_behalf_of`. Ignored for non-admin keys. |

The key is sent as the `X-Redmine-API-Key` header on every request.

### 👥 User impersonation ("user assertion")

If you run a shared **admin** API key but want each action attributed to the
actual end user, use impersonation. Every tool accepts an optional `on_behalf_of`
argument (a Redmine **login or email**); the AI supplies the currently logged-in
user per request. When the key is an admin key, the server resolves the value to a
login and sends Redmine's `X-Redmine-Switch-User` header so the action is recorded
as that user. Emails are resolved to the matching login automatically.

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

## 💡 Example prompts

Once wired up, try asking your AI:

- *"Show me my open Redmine tickets, sorted by recent updates."*
- *"Summarize issue 153285 and list what the last three comments asked for."*
- *"Create a bug report in project `webchart` titled 'Login loop on iOS 26', priority high."*
- *"Post a comment on #12345 saying the fix is deployed to DEV."*
- *"How many hours did I log this week across all projects?"*
- *"Log 45 minutes to issue 9001 with the comment 'pairing with Aris'."*

## 🔐 Security

- The server is **stdio-only**; it doesn't open any ports.
- Your API key is read from the environment at startup — never hard-code it into a repository.
- Rotate the key immediately in Redmine if it is ever exposed.
- See [SECURITY.md](SECURITY.md) for responsible-disclosure contact info.

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
