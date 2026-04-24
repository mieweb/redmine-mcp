# Security Policy

## Supported Versions

Only the latest `0.x` release is actively supported.

## Reporting a Vulnerability

If you discover a security issue, **do not** open a public GitHub issue.

Instead, email the maintainers at **security@mieweb.com** with:
- A clear description of the issue
- Steps to reproduce
- The potential impact

You should get an acknowledgement within a few business days.

## Handling API keys

The server reads `REDMINE_API_KEY` from the environment. Treat that key like a
password:

- Never commit it to a repository.
- Never paste it into screenshots, issues, or chat transcripts.
- Rotate it in Redmine (My account → API access key → Reset) if it has been
  exposed.
- Prefer a dedicated service-account API key over a personal one for shared
  deployments.
