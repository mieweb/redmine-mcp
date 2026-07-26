#!/usr/bin/env node
/**
 * Redmine MCP Server
 *
 * Exposes a minimal set of Redmine REST API operations as MCP tools.
 * Auth: uses the `X-Redmine-API-Key` header.
 *
 * Environment variables:
 *   REDMINE_URL           Base URL of the Redmine instance (e.g. https://redmine.example.com)
 *   REDMINE_API_KEY       API key for authentication
 *   REDMINE_ON_BEHALF_OF  (optional) Default user to act on behalf of — a Redmine
 *                         login or email. Requires REDMINE_API_KEY to belong to an
 *                         admin. Used as the fallback when a tool call does not pass
 *                         its own `on_behalf_of` argument. Ignored for non-admin keys.
 *
 * User impersonation ("user assertion"):
 *   Any tool accepts an optional `on_behalf_of` argument (login or email). When the
 *   configured API key is an admin key, the request is sent with Redmine's
 *   `X-Redmine-Switch-User` header so the action is attributed to that user. Emails
 *   are resolved to the matching Redmine login automatically. For non-admin keys the
 *   argument is ignored and the request behaves exactly as before (acts as the key
 *   owner), so existing setups are unaffected.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REDMINE_URL = (process.env.REDMINE_URL || "").replace(/\/+$/, "");
const REDMINE_API_KEY = process.env.REDMINE_API_KEY || "";
const REDMINE_ON_BEHALF_OF = (process.env.REDMINE_ON_BEHALF_OF || "").trim();

if (!REDMINE_URL) {
	console.error("[redmine-mcp] REDMINE_URL is not set");
}
if (!REDMINE_API_KEY) {
	console.error("[redmine-mcp] REDMINE_API_KEY is not set");
}

// Carries the impersonation target (a resolved Redmine login) through the async
// call chain of a single tool invocation, so redmineRequest/redmineDownload can
// add the X-Redmine-Switch-User header without every call site passing it.
const reqCtx = new AsyncLocalStorage();

// Build the shared auth headers, adding the impersonation header when the current
// tool invocation has a resolved switch-user login in context.
function authHeaders(extra) {
	const headers = { "X-Redmine-API-Key": REDMINE_API_KEY, ...extra };
	const switchUser = reqCtx.getStore()?.switchUser;
	if (switchUser) {
		headers["X-Redmine-Switch-User"] = switchUser;
	}
	return headers;
}

async function redmineRequest(path, { method = "GET", query, body } = {}) {
	if (!REDMINE_URL) throw new Error("REDMINE_URL is not configured");
	if (!REDMINE_API_KEY) throw new Error("REDMINE_API_KEY is not configured");

	const url = new URL(REDMINE_URL + path);
	if (query && typeof query === "object") {
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined || v === null || v === "") continue;
			url.searchParams.set(k, String(v));
		}
	}

	const headers = authHeaders({ Accept: "application/json" });
	const init = { method, headers };
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(body);
	}

	const res = await fetch(url, init);
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text };
	}
	if (!res.ok) {
		const switchUser = reqCtx.getStore()?.switchUser;
		if (res.status === 412 && switchUser) {
			throw new Error(
				`Redmine impersonation failed: user '${switchUser}' does not exist or is not active (X-Redmine-Switch-User returned 412).`
			);
		}
		throw new Error(
			`Redmine ${method} ${url.pathname} failed: ${res.status} ${res.statusText} - ${text.slice(0, 500)}`
		);
	}
	return json;
}

async function redmineDownload(absoluteUrl) {
	if (!REDMINE_API_KEY) throw new Error("REDMINE_API_KEY is not configured");
	const res = await fetch(absoluteUrl, {
		headers: authHeaders(),
	});
	if (!res.ok) {
		throw new Error(
			`Redmine download ${absoluteUrl} failed: ${res.status} ${res.statusText}`
		);
	}
	const mimeType =
		res.headers.get("content-type")?.split(";")[0]?.trim() ||
		"application/octet-stream";
	const buf = Buffer.from(await res.arrayBuffer());
	return { mimeType, buffer: buf };
}

function ok(data) {
	return {
		content: [
			{ type: "text", text: JSON.stringify(data, null, 2) },
		],
	};
}

function err(message) {
	return {
		isError: true,
		content: [{ type: "text", text: `Error: ${message}` }],
	};
}

// ---------------------------------------------------------------------------
// User impersonation ("user assertion") support
// ---------------------------------------------------------------------------

// Optional argument accepted by every tool: act on behalf of a Redmine user.
const ON_BEHALF_OF_PROP = {
	on_behalf_of: {
		type: "string",
		description:
			"Act on behalf of this Redmine user (login or email). Requires an admin API key; ignored for non-admin keys. Overrides the REDMINE_ON_BEHALF_OF env default.",
	},
};

// Lazily determine (once per process) whether the configured API key is an admin.
// Only admin keys may impersonate or search all users, so impersonation is a no-op
// otherwise — keeping existing non-admin setups seamless.
let _isAdminPromise;
async function ensureAdmin() {
	if (!_isAdminPromise) {
		_isAdminPromise = (async () => {
			try {
				const data = await redmineRequest("/users/current.json");
				return data?.user?.admin === true;
			} catch (e) {
				console.error(
					`[redmine-mcp] admin check failed, impersonation disabled: ${e?.message || e}`
				);
				return false;
			}
		})();
	}
	return _isAdminPromise;
}

// Cache identity (login or email) -> resolved Redmine login.
const _loginCache = new Map();

// Resolve an impersonation identity to a Redmine login. Logins are returned as-is;
// emails are looked up via the (admin-only) users API and matched on the mail field.
async function resolveLogin(identity) {
	const value = String(identity).trim();
	if (!value) return null;
	if (_loginCache.has(value)) return _loginCache.get(value);

	// Not an email -> treat as a login directly.
	if (!value.includes("@")) {
		_loginCache.set(value, value);
		return value;
	}

	const data = await redmineRequest("/users.json", {
		query: { name: value, limit: 100 },
	});
	const users = data?.users || [];
	const match = users.find(
		(u) => (u.mail || "").toLowerCase() === value.toLowerCase()
	);
	if (!match?.login) {
		throw new Error(
			`Could not resolve '${value}' to a Redmine login (no active user with that email).`
		);
	}
	_loginCache.set(value, match.login);
	return match.login;
}

const TOOLS = [
	{
		name: "redmine_list_projects",
		description: "List projects visible to the authenticated user.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "integer", description: "Max results (default 25, max 100)", minimum: 1, maximum: 100 },
				offset: { type: "integer", description: "Pagination offset", minimum: 0 },
			},
		},
	},
	{
		name: "redmine_get_project",
		description: "Get a single project by id or identifier.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "Numeric project id or string identifier" },
			},
		},
	},
	{
		name: "redmine_list_issues",
		description: "List/search issues with optional filters.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string", description: "Project id or identifier to filter by" },
				assigned_to_id: { type: "string", description: "User id, 'me', or group id" },
				author_id: { type: "string" },
				status_id: { type: "string", description: "e.g. 'open', 'closed', '*', or a numeric id" },
				tracker_id: { type: "integer" },
				priority_id: { type: "integer" },
				subject: { type: "string", description: "Match against the subject (use '~term' for contains)" },
				query_id: { type: "integer", description: "Saved query id" },
				sort: { type: "string", description: "Sort field, e.g. 'updated_on:desc'" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
				offset: { type: "integer", minimum: 0 },
			},
		},
	},
	{
		name: "redmine_get_issue",
		description: "Get a single issue with journals, attachments, children, and relations.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "integer", description: "Issue id" },
				include: {
					type: "string",
					description: "Comma-separated include list (default: journals,attachments,children,relations,watchers)",
				},
			},
		},
	},
	{
		name: "redmine_create_issue",
		description: "Create a new issue.",
		inputSchema: {
			type: "object",
			required: ["project_id", "subject"],
			properties: {
				project_id: { type: "string", description: "Project id or identifier" },
				subject: { type: "string" },
				description: { type: "string" },
				tracker_id: { type: "integer" },
				status_id: { type: "integer" },
				priority_id: { type: "integer" },
				assigned_to_id: { type: "string" },
				category_id: { type: "integer" },
				fixed_version_id: { type: "integer" },
				parent_issue_id: { type: "integer" },
				start_date: { type: "string", description: "YYYY-MM-DD" },
				due_date: { type: "string", description: "YYYY-MM-DD" },
				estimated_hours: { type: "number" },
				done_ratio: { type: "integer", minimum: 0, maximum: 100 },
				watcher_user_ids: { type: "array", items: { type: "integer" } },
			},
		},
	},
	{
		name: "redmine_update_issue",
		description: "Update an existing issue. Any provided fields are updated.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "integer" },
				subject: { type: "string" },
				description: { type: "string" },
				notes: { type: "string", description: "Add a journal note (comment)" },
				private_notes: { type: "boolean" },
				status_id: { type: "integer" },
				priority_id: { type: "integer" },
				assigned_to_id: { type: "string" },
				tracker_id: { type: "integer" },
				category_id: { type: "integer" },
				fixed_version_id: { type: "integer" },
				done_ratio: { type: "integer", minimum: 0, maximum: 100 },
				due_date: { type: "string" },
				start_date: { type: "string" },
				estimated_hours: { type: "number" },
			},
		},
	},
	{
		name: "redmine_add_issue_note",
		description: "Add a comment (journal note) to an issue.",
		inputSchema: {
			type: "object",
			required: ["id", "notes"],
			properties: {
				id: { type: "integer" },
				notes: { type: "string" },
				private_notes: { type: "boolean" },
			},
		},
	},
	{
		name: "redmine_list_users",
		description: "List users (requires admin) or get current user via 'me'.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Filter by first/last/login name substring" },
				status: { type: "integer", description: "1=active, 2=registered, 3=locked" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
				offset: { type: "integer", minimum: 0 },
			},
		},
	},
	{
		name: "redmine_current_user",
		description: "Get the currently authenticated user (based on the API key).",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "redmine_search",
		description: "Full-text search across Redmine.",
		inputSchema: {
			type: "object",
			required: ["q"],
			properties: {
				q: { type: "string", description: "Search query" },
				scope: { type: "string", description: "e.g. 'all', or project identifier" },
				issues: { type: "integer", description: "1 to include issues" },
				news: { type: "integer" },
				documents: { type: "integer" },
				wiki_pages: { type: "integer" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
				offset: { type: "integer", minimum: 0 },
			},
		},
	},
	{
		name: "redmine_list_time_entries",
		description: "List time entries with optional filters.",
		inputSchema: {
			type: "object",
			properties: {
				user_id: { type: "string" },
				project_id: { type: "string" },
				issue_id: { type: "integer" },
				from: { type: "string", description: "YYYY-MM-DD" },
				to: { type: "string", description: "YYYY-MM-DD" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
				offset: { type: "integer", minimum: 0 },
			},
		},
	},
	{
		name: "redmine_create_time_entry",
		description: "Log time against an issue or project.",
		inputSchema: {
			type: "object",
			required: ["hours"],
			properties: {
				issue_id: { type: "integer" },
				project_id: { type: "string" },
				hours: { type: "number" },
				spent_on: { type: "string", description: "YYYY-MM-DD (default: today)" },
				activity_id: { type: "integer" },
				comments: { type: "string" },
			},
		},
	},
	{
		name: "redmine_list_issue_attachments",
		description:
			"List attachments on an issue (id, filename, content_type, filesize, content_url). Use redmine_get_attachment to download one.",
		inputSchema: {
			type: "object",
			required: ["issue_id"],
			properties: {
				issue_id: { type: "integer" },
			},
		},
	},
	{
		name: "redmine_get_attachment",
		description:
			"Download a Redmine attachment by id. Images (png/jpeg/gif/webp) are returned as MCP image content so the model can view them directly. Other file types are returned as base64 plus metadata. Optionally write the raw bytes to a local path via save_to.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "integer", description: "Attachment id (from redmine_list_issue_attachments or redmine_get_issue)" },
				save_to: {
					type: "string",
					description: "Optional absolute or relative filesystem path to also write the raw bytes to.",
				},
				max_bytes: {
					type: "integer",
					description: "Refuse to inline attachments larger than this (default 10485760 = 10 MiB). save_to still works.",
				},
			},
		},
	},
];

// Every tool supports optional per-call impersonation via `on_behalf_of`.
for (const tool of TOOLS) {
	tool.inputSchema = tool.inputSchema || { type: "object", properties: {} };
	tool.inputSchema.properties = {
		...tool.inputSchema.properties,
		...ON_BEHALF_OF_PROP,
	};
}

async function handleTool(name, args) {
	args = args || {};
	switch (name) {
		case "redmine_list_projects":
			return ok(await redmineRequest("/projects.json", { query: args }));

		case "redmine_get_project":
			return ok(await redmineRequest(`/projects/${encodeURIComponent(args.id)}.json`));

		case "redmine_list_issues":
			return ok(await redmineRequest("/issues.json", { query: args }));

		case "redmine_get_issue": {
			const include = args.include || "journals,attachments,children,relations,watchers";
			return ok(
				await redmineRequest(`/issues/${args.id}.json`, { query: { include } })
			);
		}

		case "redmine_create_issue": {
			const { project_id, ...rest } = args;
			return ok(
				await redmineRequest("/issues.json", {
					method: "POST",
					body: { issue: { project_id, ...rest } },
				})
			);
		}

		case "redmine_update_issue": {
			const { id, ...rest } = args;
			await redmineRequest(`/issues/${id}.json`, {
				method: "PUT",
				body: { issue: rest },
			});
			return ok({ ok: true, id });
		}

		case "redmine_add_issue_note": {
			const { id, notes, private_notes } = args;
			await redmineRequest(`/issues/${id}.json`, {
				method: "PUT",
				body: { issue: { notes, private_notes } },
			});
			return ok({ ok: true, id });
		}

		case "redmine_list_users":
			return ok(await redmineRequest("/users.json", { query: args }));

		case "redmine_current_user":
			return ok(await redmineRequest("/users/current.json"));

		case "redmine_search":
			return ok(await redmineRequest("/search.json", { query: args }));

		case "redmine_list_time_entries":
			return ok(await redmineRequest("/time_entries.json", { query: args }));

		case "redmine_create_time_entry":
			return ok(
				await redmineRequest("/time_entries.json", {
					method: "POST",
					body: { time_entry: args },
				})
			);

		case "redmine_list_issue_attachments": {
			const data = await redmineRequest(`/issues/${args.issue_id}.json`, {
				query: { include: "attachments" },
			});
			const atts = (data?.issue?.attachments || []).map((a) => ({
				id: a.id,
				filename: a.filename,
				content_type: a.content_type,
				filesize: a.filesize,
				description: a.description,
				author: a.author,
				created_on: a.created_on,
				content_url: a.content_url,
			}));
			return ok({ issue_id: args.issue_id, count: atts.length, attachments: atts });
		}

		case "redmine_get_attachment": {
			const meta = await redmineRequest(`/attachments/${args.id}.json`);
			const att = meta?.attachment;
			if (!att) throw new Error(`Attachment ${args.id} not found`);
			const maxBytes = Number.isFinite(args.max_bytes)
				? Number(args.max_bytes)
				: 10 * 1024 * 1024;
			const { mimeType, buffer } = await redmineDownload(att.content_url);

			if (args.save_to) {
				const fs = await import("node:fs/promises");
				const path = await import("node:path");
				const dest = path.resolve(String(args.save_to));
				await fs.mkdir(path.dirname(dest), { recursive: true });
				await fs.writeFile(dest, buffer);
				att.saved_to = dest;
			}

			const info = {
				id: att.id,
				filename: att.filename,
				content_type: att.content_type || mimeType,
				filesize: att.filesize ?? buffer.length,
				description: att.description,
				author: att.author,
				created_on: att.created_on,
				saved_to: att.saved_to,
			};

			const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType);

			if (buffer.length > maxBytes) {
				return ok({
					...info,
					note: `Attachment is ${buffer.length} bytes which exceeds max_bytes=${maxBytes}. ${args.save_to ? "Bytes were written to save_to." : "Re-call with a larger max_bytes or provide save_to."}`,
					inlined: false,
				});
			}

			const base64 = buffer.toString("base64");

			if (isImage) {
				return {
					content: [
						{ type: "text", text: JSON.stringify(info, null, 2) },
						{ type: "image", data: base64, mimeType },
					],
				};
			}

			return ok({ ...info, base64, inlined: true });
		}

		default:
			return err(`Unknown tool: ${name}`);
	}
}

const server = new Server(
	{ name: "redmine-mcp", version: "0.1.0" },
	{ capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: rawArgs } = request.params;
	const args = { ...(rawArgs || {}) };
	try {
		// Resolve optional impersonation (per-call arg overrides env default).
		const identity = (args.on_behalf_of ?? REDMINE_ON_BEHALF_OF) || "";
		delete args.on_behalf_of;

		if (identity && (await ensureAdmin())) {
			const switchUser = await resolveLogin(identity);
			return await reqCtx.run({ switchUser }, () => handleTool(name, args));
		}
		return await handleTool(name, args);
	} catch (e) {
		return err(e?.message || String(e));
	}
});

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
	console.error("[redmine-mcp] fatal:", e);
	process.exit(1);
});
