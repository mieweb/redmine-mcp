# Contributing

Thanks for your interest in improving `redmine-mcp`. This document covers the basics.

## Development setup

```bash
git clone https://github.com/mieweb/redmine-mcp.git
cd redmine-mcp
npm install
```

Run the server locally against your own Redmine instance:

```bash
REDMINE_URL=https://your-redmine.example.com \
REDMINE_API_KEY=your_api_key \
node index.js
```

The server speaks [MCP](https://modelcontextprotocol.io) over stdio. Point any
MCP client (VS Code, Claude Desktop, etc.) at the command above.

To test the Streamable HTTP transport instead:

```bash
REDMINE_URL=https://your-redmine.example.com \
MCP_HTTP_PORT=3000 \
node index.js --http
```

It listens on `http://127.0.0.1:3000/mcp`. Send `Authorization: Bearer <api-key>`
to authenticate per request — it overrides `REDMINE_API_KEY` — and optionally
`X-Redmine-On-Behalf-Of: <login|email>` to set the impersonation identity.

## Guidelines

- **Keep it simple.** The whole server fits in a single `index.js` on purpose.
- **No hard-coded URLs or keys.** Everything flows through env vars.
- **One tool, one responsibility.** Mirror the Redmine REST endpoints closely.
- **Stable names.** Tool names are public API — renaming breaks users.
- Run `node --check index.js` before opening a PR.

## Reporting issues

Open a GitHub issue with:
1. Redmine version (visible at `/admin/info`)
2. The tool call you made
3. Expected vs. actual behavior
4. Any stderr output from the server

## Security

Do **not** report security issues in public GitHub issues.
See [SECURITY.md](SECURITY.md) for the responsible disclosure process.
