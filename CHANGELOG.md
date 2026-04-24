# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-24

### Added
- Initial Redmine MCP server implementation.
- Tools: `redmine_current_user`, `redmine_list_projects`, `redmine_get_project`,
  `redmine_list_issues`, `redmine_get_issue`, `redmine_create_issue`,
  `redmine_update_issue`, `redmine_add_issue_note`, `redmine_list_users`,
  `redmine_search`, `redmine_list_time_entries`, `redmine_create_time_entry`.
- Stdio transport via `@modelcontextprotocol/sdk`.
- Configuration via `REDMINE_URL` and `REDMINE_API_KEY` environment variables.
