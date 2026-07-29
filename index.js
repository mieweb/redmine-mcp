#!/usr/bin/env node
/**
 * Redmine MCP Server
 *
 * Exposes a minimal set of Redmine REST API operations as MCP tools.
 * Auth: uses the `X-Redmine-API-Key` header.
 *
 * Transports:
 *   stdio (default) — `node index.js`
 *   Streamable HTTP — `node index.js --http` (or set PORT / MCP_HTTP_PORT).
 *                     In HTTP mode each request may carry its own credential as
 *                     `Authorization: Bearer <redmine-api-key>`, which overrides
 *                     REDMINE_API_KEY for that request. This lets one server
 *                     process serve many users, each acting as themselves.
 *                     A request may also carry an identity header (by default
 *                     `X-Redmine-User`, `X-Redmine-On-Behalf-Of`, `X-On-Behalf-Of`,
 *                     `X-Ozwell-User-Email` or `X-Ozwell-User-Name`; configurable via
 *                     REDMINE_USER_HEADERS)
 *                     to set the impersonation identity from the transport layer
 *                     instead of a model-chosen tool argument.
 *
 * Environment variables:
 *   REDMINE_URL           Base URL of the Redmine instance (e.g. https://redmine.example.com)
 *   REDMINE_API_KEY       (optional) Default API key. Used when a request does not
 *                         supply an `Authorization: Bearer <key>` header. A request
 *                         bearer token always takes precedence.
 *   MCP_HTTP_PORT / PORT  (optional) Port for the Streamable HTTP transport.
 *                         Setting either implies `--http`. Default 3000.
 *   MCP_HTTP_HOST         (optional) Bind address for HTTP mode (default 127.0.0.1).
 *   MCP_ALLOWED_HOSTS     (optional) Comma-separated Host header allow-list. When set,
 *                         DNS-rebinding protection is enabled for HTTP mode.
 *   MCP_LOG_REQUESTS      (optional) Request/tool-call audit logging to stderr, on by
 *                         default. Set to "0"/"false"/"off" to disable. Logs who (the
 *                         impersonated login and a hashed tag of the API key — never
 *                         the key itself) and where (peer address, any X-Forwarded-For
 *                         hop, user agent), plus the tool name, outcome and duration.
 *                         Tool arguments are never logged.
 *   REDMINE_USER_HEADERS  (optional) Comma-separated, ordered list of incoming request
 *                         headers that may carry the impersonation identity (login or
 *                         email). The first one present on the request wins. Default:
 *                         x-redmine-user,x-redmine-on-behalf-of,x-on-behalf-of,x-ozwell-user-email,x-ozwell-user-name
 *   REDMINE_ON_BEHALF_OF  (optional) Default user to act on behalf of — a Redmine
 *                         login or email. Requires REDMINE_API_KEY to belong to an
 *                         admin. Used as the fallback when a tool call does not pass
 *                         its own `on_behalf_of` argument. Ignored for non-admin keys.
 *   REDMINE_LOCK_ON_BEHALF_OF (optional) When truthy ("1", "true", "yes"), the
 *                         identity is LOCKED to REDMINE_ON_BEHALF_OF: the per-call
 *                         `on_behalf_of` argument is not advertised and is ignored,
 *                         so a (possibly prompt-injected) model cannot impersonate a
 *                         different user. Use this for shared-admin-key deployments
 *                         that spawn one server per authenticated session.
 *   REDMINE_ALLOW_ADMIN   (optional) When truthy ("1", "true", "yes"), allows tool
 *                         calls to run as the admin key owner when no impersonation
 *                         identity is in effect. By default this is FAIL-CLOSED: if
 *                         the API key is an admin key and no identity is resolved,
 *                         the server refuses the call instead of silently acting
 *                         with full admin privileges. Set this only when you
 *                         intentionally want to operate as the admin account itself.
 *
 * User impersonation ("user assertion"):
 *   Any tool accepts an optional `on_behalf_of` argument (login or email). When the
 *   configured API key is an admin key, the request is sent with Redmine's
 *   `X-Redmine-Switch-User` header so the action is attributed to that user. Emails
 *   are resolved to the matching Redmine login automatically. For non-admin keys the
 *   argument is ignored and the request behaves exactly as before (acts as the key
 *   owner), so existing setups are unaffected.
 *
 *   Identity precedence, most trusted first:
 *     1. REDMINE_ON_BEHALF_OF when REDMINE_LOCK_ON_BEHALF_OF is set (env lock)
 *     2. the first REDMINE_USER_HEADERS header present on the request
 *     3. the `on_behalf_of` tool argument (chosen by the model)
 *     4. REDMINE_ON_BEHALF_OF as a plain default
 *   Levels 1 and 2 also hide the `on_behalf_of` argument from tools/list, so the
 *   model cannot select or drop the identity.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REDMINE_URL = (process.env.REDMINE_URL || "").replace(/\/+$/, "");
const REDMINE_API_KEY = process.env.REDMINE_API_KEY || "";
const REDMINE_ON_BEHALF_OF = (process.env.REDMINE_ON_BEHALF_OF || "").trim();
const REDMINE_LOCK_ON_BEHALF_OF = /^(1|true|yes)$/i.test(
	(process.env.REDMINE_LOCK_ON_BEHALF_OF || "").trim()
);
const REDMINE_ALLOW_ADMIN = /^(1|true|yes)$/i.test(
	(process.env.REDMINE_ALLOW_ADMIN || "").trim()
);

const HTTP_PORT = Number(process.env.MCP_HTTP_PORT || process.env.PORT || 0);
const HTTP_MODE = process.argv.includes("--http") || HTTP_PORT > 0;
const HTTP_HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";

// Ordered list of incoming request headers that may carry the impersonation
// identity (a Redmine login or email). The first header present on the request
// wins, so an explicit override can be listed ahead of headers injected
// automatically by an upstream platform.
const DEFAULT_USER_HEADERS = [
	"x-redmine-user", // explicit override
	"x-redmine-on-behalf-of",
	"x-on-behalf-of",
	"x-ozwell-user-email", // Ozwell AI platform (auto) — an address we can resolve
	"x-ozwell-user-name", // Ozwell AI platform (auto) — a DISPLAY name ("Doug Horner"),
	// only usable as a last resort and only when it happens to be a login
];
const USER_HEADERS = (() => {
	const configured = (process.env.REDMINE_USER_HEADERS || "")
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set(configured.length ? configured : DEFAULT_USER_HEADERS)];
})();

const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS || "")
	.split(",")
	.map((h) => h.trim())
	.filter(Boolean);

if (!REDMINE_URL) {
	console.error("[redmine-mcp] REDMINE_URL is not set");
}
if (!REDMINE_API_KEY) {
	console.error(
		HTTP_MODE
			? "[redmine-mcp] REDMINE_API_KEY is not set; every request must send 'Authorization: Bearer <redmine-api-key>'"
			: "[redmine-mcp] REDMINE_API_KEY is not set"
	);
}
if (REDMINE_LOCK_ON_BEHALF_OF) {
	if (REDMINE_ON_BEHALF_OF) {
		console.error(
			`[redmine-mcp] Identity locked to '${REDMINE_ON_BEHALF_OF}'; per-call on_behalf_of is disabled.`
		);
	} else {
		console.error(
			"[redmine-mcp] REDMINE_LOCK_ON_BEHALF_OF is set but REDMINE_ON_BEHALF_OF is empty; requests will act as the API key owner and impersonation is disabled."
		);
	}
}
if (REDMINE_ALLOW_ADMIN) {
	console.error(
		"[redmine-mcp] REDMINE_ALLOW_ADMIN is set; tool calls may run with full admin privileges when no impersonation identity is in effect."
	);
}

// Carries per-request state — the caller's API key (from an Authorization Bearer
// header), a transport-supplied impersonation identity, and the resolved Redmine
// login to switch to — through the async call chain of a single tool invocation,
// so redmineRequest/redmineDownload can set the auth and X-Redmine-Switch-User
// headers without every call site passing them.
const reqCtx = new AsyncLocalStorage();

// Run `fn` with the current context patched (never dropping fields such as the
// per-request API key).
function withCtx(patch, fn) {
	return reqCtx.run({ ...reqCtx.getStore(), ...patch }, fn);
}

// The API key for the current request: a per-request bearer token wins over the
// REDMINE_API_KEY env default.
function currentApiKey() {
	return reqCtx.getStore()?.apiKey || REDMINE_API_KEY;
}

const MISSING_KEY_MESSAGE =
	"No Redmine API key: set REDMINE_API_KEY or send an 'Authorization: Bearer <redmine-api-key>' header";

// Stable, non-reversible tag for an API key. Caches are per-key because admin
// status and visible projects/users differ between credentials — and the raw key
// must never end up in a cache key, or a log line, that could leak it.
const _keyTags = new Map();
function tagFor(key) {
	if (!key) return "anon";
	let tag = _keyTags.get(key);
	if (!tag) {
		tag = createHash("sha256").update(key).digest("hex").slice(0, 12);
		_keyTags.set(key, tag);
	}
	return tag;
}

function keyTag() {
	return tagFor(currentApiKey());
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

const LOG_REQUESTS = !/^(0|false|no|off)$/i.test(
	(process.env.MCP_LOG_REQUESTS || "").trim()
);

// Log values come from request headers, so they are attacker-controlled: collapse
// newlines (log-forging) and cap the length before they reach the journal.
function logValue(value) {
	const text = String(value).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
	return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

// One `key=value` line per event, so `journalctl -u redmine-mcp` stays greppable.
function logEvent(event, fields) {
	if (!LOG_REQUESTS) return;
	const parts = [`[redmine-mcp] ${event}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null || value === "") continue;
		parts.push(`${key}=${logValue(value)}`);
	}
	console.error(parts.join(" "));
}

// Where the call came from. `fwd` is the first X-Forwarded-For hop: it is set by
// the client and is only meaningful behind a reverse proxy that overwrites it, so
// it is logged alongside — never instead of — the real peer address.
function clientInfo(req) {
	return {
		ip: req.socket?.remoteAddress || "",
		fwd: String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim(),
		ua: String(req.headers?.["user-agent"] || ""),
	};
}

// Cache scope for the current credential + impersonation identity.
function cacheScope() {
	return `${keyTag()}:${reqCtx.getStore()?.switchUser || ""}`;
}

// Build the shared auth headers, adding the impersonation header when the current
// tool invocation has a resolved switch-user login in context.
function authHeaders(extra) {
	const headers = { "X-Redmine-API-Key": currentApiKey(), ...extra };
	const switchUser = reqCtx.getStore()?.switchUser;
	if (switchUser) {
		headers["X-Redmine-Switch-User"] = switchUser;
	}
	return headers;
}

async function redmineRequest(path, { method = "GET", query, body } = {}) {
	if (!REDMINE_URL) throw new Error("REDMINE_URL is not configured");
	if (!currentApiKey()) throw new Error(MISSING_KEY_MESSAGE);

	const url = new URL(REDMINE_URL + path);
	if (query && typeof query === "object") {
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined || v === null || v === "") continue;
			// LLM clients often fill optional numeric filters (tracker_id,
			// priority_id, etc.) with 0. Redmine filter IDs are never 0, and
			// forwarding tracker_id=0 silently returns an empty result set, so
			// drop numeric-zero filters. Pagination is handled explicitly below.
			if (typeof v === "number" && v === 0 && k !== "offset") continue;
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
	if (!currentApiKey()) throw new Error(MISSING_KEY_MESSAGE);
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

// Lazily determine (once per API key) whether the configured API key is an admin.
// Only admin keys may impersonate or search all users, so impersonation is a no-op
// otherwise — keeping existing non-admin setups seamless.
const _isAdminPromises = new Map();
async function ensureAdmin() {
	const tag = keyTag();
	if (!_isAdminPromises.has(tag)) {
		_isAdminPromises.set(
			tag,
			(async () => {
				try {
					const data = await redmineRequest("/users/current.json");
					return data?.user?.admin === true;
				} catch (e) {
					console.error(
						`[redmine-mcp] admin check failed, impersonation disabled: ${e?.message || e}`
					);
					return false;
				}
			})()
		);
	}
	return _isAdminPromises.get(tag);
}

// Cache `${keyTag}:${identity}` (login or email) -> resolved Redmine login.
const _loginCache = new Map();

// Resolve an impersonation identity to a Redmine login. Logins are returned as-is;
// emails are looked up via the (admin-only) users API and matched on the mail field.
async function resolveLogin(identity) {
	const value = String(identity).trim();
	if (!value) return null;
	const cacheKey = `${keyTag()}:${value}`;
	if (_loginCache.has(cacheKey)) return _loginCache.get(cacheKey);

	// Not an email -> treat as a login directly.
	if (!value.includes("@")) {
		_loginCache.set(cacheKey, value);
		return value;
	}

	const data = await redmineRequest("/users.json", {
		query: { name: value, limit: 100 },
	});
	const users = data?.users || [];
	const match = users.find(
		(u) => (u.mail || "").toLowerCase() === value.toLowerCase()
	);
	if (match?.login) {
		_loginCache.set(cacheKey, match.login);
		return match.login;
	}

	// Fallback: assume the local part of the address is the login. Redmine only
	// exposes `mail` to admin keys and only for users the key can see, so the
	// lookup above misses whenever the address is not visible — common with SSO
	// directories where login and email local part are the same string anyway.
	// A wrong guess is not silent: Redmine rejects the switch-user with a 412.
	const localPart = value.slice(0, value.indexOf("@")).trim();
	if (localPart) {
		console.error(
			`[redmine-mcp] no Redmine user found with email '${value}'; assuming login '${localPart}'`
		);
		_loginCache.set(cacheKey, localPart);
		return localPart;
	}

	throw new Error(
		`Could not resolve '${value}' to a Redmine login (no active user with that email).`
	);
}

// ---------------------------------------------------------------------------
// Named-reference resolution
// ---------------------------------------------------------------------------
// LLM callers pass human-facing display names (e.g. project "Bluehive AI",
// status "New", tracker "Bug") where the Redmine API expects a numeric id or a
// project identifier ("bluehive-ai"). These helpers transparently map a display
// name to the value the API accepts. Numeric input, project identifiers, and
// status keywords (open/closed/*) are passed through untouched.

const _refCache = new Map(); // `${keyTag}:${switchUser}:${key}` -> { at, list }
const REF_CACHE_TTL_MS = 60_000;

async function loadRef(cacheKey, fetcher) {
	const key = `${cacheScope()}:${cacheKey}`;
	const cached = _refCache.get(key);
	if (cached && Date.now() - cached.at < REF_CACHE_TTL_MS) return cached.list;
	const list = await fetcher();
	_refCache.set(key, { at: Date.now(), list });
	return list;
}

function slugify(value) {
	return String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Resolve a project reference (numeric id, identifier, or display name) to a
// value the Redmine API accepts (numeric id or identifier). Resolution is cheap:
// a slugified direct lookup and a server-side name filter cover the common
// cases, and results are cached so repeated calls are instant. A full paged
// scan is only used as a last resort.
const _projectResolveCache = new Map(); // `${keyTag}:${switchUser}:${lower(value)}` -> resolved

async function projectByRef(ref) {
	try {
		const data = await redmineRequest(
			`/projects/${encodeURIComponent(ref)}.json`
		);
		return data?.project || null;
	} catch {
		return null;
	}
}

async function resolveProject(value) {
	const v = String(value ?? "").trim();
	if (!v || /^\d+$/.test(v)) return v; // empty or numeric id

	const cacheKey = `${cacheScope()}:${v.toLowerCase()}`;
	if (_projectResolveCache.has(cacheKey)) return _projectResolveCache.get(cacheKey);

	const remember = (resolved) => {
		_projectResolveCache.set(cacheKey, resolved);
		return resolved;
	};

	// 1. Slugified direct lookup ("Bluehive AI" -> "bluehive-ai"). Also catches
	//    values that are already a valid identifier.
	const slug = slugify(v);
	if (slug) {
		const p = await projectByRef(slug);
		if (p) return remember(p.identifier || String(p.id));
	}

	// 2. Server-side name filter (a single request even on large instances).
	try {
		const data = await redmineRequest("/projects.json", {
			query: { name: v, limit: 100 },
		});
		const projects = data?.projects || [];
		const lower = v.toLowerCase();
		const match =
			projects.find((p) => (p.name || "").trim().toLowerCase() === lower) ||
			projects.find((p) => p.identifier === v) ||
			projects.find((p) => p.identifier === slug) ||
			(projects.length === 1 ? projects[0] : null);
		if (match) return remember(match.identifier || String(match.id));
	} catch {
		/* fall through to full scan */
	}

	// 3. Last resort: page through every visible project and match by name.
	try {
		const all = await loadRef("projects", async () => {
			const acc = [];
			let offset = 0;
			for (;;) {
				const data = await redmineRequest("/projects.json", {
					query: { limit: 100, offset },
				});
				const batch = data?.projects || [];
				acc.push(...batch);
				const total = data?.total_count ?? acc.length;
				offset += batch.length;
				if (batch.length === 0 || acc.length >= total) break;
			}
			return acc;
		});
		const lower = v.toLowerCase();
		const match =
			all.find((p) => (p.name || "").trim().toLowerCase() === lower) ||
			all.find((p) => p.identifier === slug);
		if (match) return remember(match.identifier || String(match.id));
	} catch {
		/* give up */
	}

	return remember(v); // unknown: pass through unchanged
}

// Build a resolver for a small global enumeration (trackers, priorities, ...).
function makeEnumResolver(cacheKey, path, listKey) {
	return async function (value) {
		const v = String(value ?? "").trim();
		if (!v || /^\d+$/.test(v)) return v; // empty or numeric id
		let items;
		try {
			items = await loadRef(cacheKey, async () => {
				const data = await redmineRequest(path);
				return data?.[listKey] || [];
			});
		} catch {
			return v;
		}
		const match = items.find(
			(it) => (it.name || "").trim().toLowerCase() === v.toLowerCase()
		);
		return match?.id != null ? String(match.id) : v;
	};
}

const resolveTracker = makeEnumResolver("trackers", "/trackers.json", "trackers");
const resolvePriority = makeEnumResolver(
	"priorities",
	"/enumerations/issue_priorities.json",
	"issue_priorities"
);

// Status accepts the special keywords open/closed/* in addition to ids/names.
async function resolveStatus(value) {
	const v = String(value ?? "").trim();
	if (!v || /^\d+$/.test(v) || /^(open|closed|\*)$/i.test(v)) return v;
	let items;
	try {
		items = await loadRef("statuses", async () => {
			const data = await redmineRequest("/issue_statuses.json");
			return data?.issue_statuses || [];
		});
	} catch {
		return v;
	}
	const match = items.find(
		(it) => (it.name || "").trim().toLowerCase() === v.toLowerCase()
	);
	return match?.id != null ? String(match.id) : v;
}

// Resolve a user reference (numeric id, 'me', login, email, or display name) to
// a numeric user id. Redmine's /users.json?name= search is a loose token match,
// so we only trust an exact login/email/full-name match — never a lone fuzzy hit.
const _userResolveCache = new Map(); // `${switchUser}:${lower(value)}` -> resolved

// Fetch users via /users.json?name=. Listing users needs admin rights, so if the
// impersonated (often non-admin) user is denied, retry with the admin key.
async function searchUsers(query) {
	const fetchUsers = async () => {
		try {
			const data = await redmineRequest("/users.json", {
				query: { name: query, limit: 100 },
			});
			return data?.users || [];
		} catch {
			return [];
		}
	};
	let users = await fetchUsers();
	if (users.length === 0 && reqCtx.getStore()?.switchUser) {
		// Re-run without the impersonation header (as the admin key).
		users = await withCtx({ switchUser: null }, fetchUsers);
	}
	return users;
}

// Strict match: login, email, or exact "firstname lastname" (case-insensitive).
// No single-result guessing — Redmine's name search is too loose to trust blindly.
function matchUser(users, value) {
	const lower = String(value).trim().toLowerCase();
	const fieldEq = (u, key) => (u?.[key] || "").trim().toLowerCase() === lower;
	const fullNameEq = (u) =>
		`${u.firstname || ""} ${u.lastname || ""}`.trim().toLowerCase() === lower;
	const match =
		users.find((u) => fieldEq(u, "login")) ||
		users.find((u) => fieldEq(u, "mail")) ||
		users.find(fullNameEq);
	return match?.id != null ? String(match.id) : null;
}

async function resolveUser(value) {
	const v = String(value ?? "").trim();
	if (!v || /^\d+$/.test(v) || /^me$/i.test(v)) return v;

	const cacheKey = `${cacheScope()}:${v.toLowerCase()}`;
	if (_userResolveCache.has(cacheKey)) return _userResolveCache.get(cacheKey);

	let users = await searchUsers(v);
	if (!matchUser(users, v)) {
		// Redmine's multi-token name search is unreliable (e.g. "Raj Gara" can miss
		// the real user); retry on the last token (usually the surname).
		const tokens = v.split(/\s+/);
		if (tokens.length > 1) users = await searchUsers(tokens[tokens.length - 1]);
	}
	const resolved = matchUser(users, v) || v;
	_userResolveCache.set(cacheKey, resolved);
	return resolved;
}

const TOOLS = [
	{
		name: "redmine_list_projects",
		description:
			"List Redmine projects visible to the current user. Use this first when you need a project to create or search issues/tickets in and the user didn't specify one.",
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
		description: "Get details of a single Redmine project by its numeric id or string identifier.",
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
		description:
			"List or search issues (also called tickets, bugs, tasks, or problem reports) with optional filters. Use for questions like 'show my open tickets', 'what bugs are assigned to X', or 'list issues in project Y'. Filters accept friendly values, not just ids: assigned_to_id/author_id take a name, login, email, or 'me'; status_id takes 'open', 'closed', '*', or a status name; project_id takes an identifier or display name. For free-text search of issue contents, prefer redmine_search.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string", description: "Project id, identifier, or display name" },
				assigned_to_id: { type: "string", description: "User id, 'me', login, email, full name, or group id" },
				author_id: { type: "string", description: "User id, login, email, or full name" },
				status_id: { type: "string", description: "'open', 'closed', '*', a status name, or a numeric id" },
				tracker_id: { type: "string", description: "Tracker id or name (e.g. 'Bug')" },
				priority_id: { type: "string", description: "Priority id or name" },
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
		description:
			`Get one issue/ticket by its id, including its full comment history (journals), attachments, child issues, and relations. Use this to read the details or discussion of a specific ticket, e.g. 'what's the status of ticket #1234'. When referring the user to a ticket, link it as ${REDMINE_URL || "<redmine-url>"}/issues/<id>.`,
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
		description:
			`Create a new issue — use this when the user wants to report a problem, file a bug, open a ticket, or add a task. Requires a project (id, identifier, or name) and a subject (short title). Put the detailed problem description in 'description'. If the project is unknown, call redmine_list_projects first. After creating, show the user the new ticket number as a link: ${REDMINE_URL || "<redmine-url>"}/issues/<id>.`,
		inputSchema: {
			type: "object",
			required: ["project_id", "subject"],
			properties: {
				project_id: { type: "string", description: "Project id, identifier, or display name" },
				subject: { type: "string" },
				description: { type: "string" },
				tracker_id: { type: "string", description: "Tracker id or name" },
				status_id: { type: "string", description: "Status id or name" },
				priority_id: { type: "string", description: "Priority id or name" },
				assigned_to_id: { type: "string", description: "User id, login, email, or full name" },
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
		description:
			"Update an existing issue/ticket: change status (e.g. close or reopen), reassign, set priority, edit the subject/description, set % done, or add a comment via 'notes'. Only the fields you provide are changed. Names work as well as ids for status, priority, assignee, and tracker.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "integer" },
				subject: { type: "string" },
				description: { type: "string" },
				notes: { type: "string", description: "Add a journal note (comment)" },
				private_notes: { type: "boolean" },
				status_id: { type: "string", description: "Status id or name" },
				priority_id: { type: "string", description: "Priority id or name" },
				assigned_to_id: { type: "string", description: "User id, login, email, or full name" },
				tracker_id: { type: "string", description: "Tracker id or name" },
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
		description:
			"Add a comment (also called a note or reply) to an existing issue/ticket. Use this when the user wants to respond on, comment on, or add information to a ticket without changing its other fields.",
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
		description:
			"Search or list Redmine user accounts, e.g. to find someone's id or login before assigning them a ticket. Requires an admin API key. For the current user, use redmine_current_user instead.",
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
		description:
			"Get the currently authenticated Redmine user — answers 'who am I?' and is useful to confirm identity before filtering issues by 'me'.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "redmine_search",
		description:
			"Full-text keyword search across Redmine (issues/tickets, wiki pages, news, documents). Use when looking for tickets by words in their text, e.g. 'find tickets mentioning the login page'. For structured filters (status, assignee, project), use redmine_list_issues instead.",
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
		description:
			"List logged time (hours worked) with optional filters by user, project, issue/ticket, or date range. Use for questions like 'how many hours did I log this week'.",
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
		description:
			"Log time (hours worked) against an issue/ticket or a project. Use when the user says things like 'log 2 hours on ticket #123'. Provide either issue_id or project_id along with hours.",
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
			"List the files/screenshots attached to an issue/ticket (returns id, filename, content_type, filesize, content_url). Then use redmine_get_attachment with the id to view or download one.",
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
			"Download or view a file attached to an issue/ticket, by attachment id (get the id from redmine_get_issue or redmine_list_issue_attachments). Images (png/jpeg/gif/webp) are returned as viewable image content; other file types are returned as base64 plus metadata. Optionally also write the raw bytes to a local path via save_to.",
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

// The identity is "pinned" when it comes from a source the model cannot influence:
// the env lock, or one of the configured identity headers set by the transport/proxy.
// Pinned requests ignore (and do not advertise) the `on_behalf_of` argument.
function pinnedIdentity() {
	if (REDMINE_LOCK_ON_BEHALF_OF) return REDMINE_ON_BEHALF_OF;
	return reqCtx.getStore()?.onBehalfOf || "";
}

// Every tool supports optional per-call impersonation via `on_behalf_of`, unless
// the identity is pinned for this request (then the argument is not advertised).
function toolsForRequest() {
	if (REDMINE_LOCK_ON_BEHALF_OF || reqCtx.getStore()?.onBehalfOf) return TOOLS;
	return TOOLS.map((tool) => {
		const schema = tool.inputSchema || { type: "object", properties: {} };
		return {
			...tool,
			inputSchema: {
				...schema,
				properties: { ...schema.properties, ...ON_BEHALF_OF_PROP },
			},
		};
	});
}

async function handleTool(name, args) {
	args = args || {};
	switch (name) {
		case "redmine_list_projects":
			return ok(await redmineRequest("/projects.json", { query: args }));

		case "redmine_get_project":
			return ok(
				await redmineRequest(
					`/projects/${encodeURIComponent(await resolveProject(args.id))}.json`
				)
			);

		case "redmine_list_issues": {
			const query = { ...args };
			if (query.project_id) query.project_id = await resolveProject(query.project_id);
			if (query.tracker_id) query.tracker_id = await resolveTracker(query.tracker_id);
			if (query.priority_id) query.priority_id = await resolvePriority(query.priority_id);
			if (query.status_id) query.status_id = await resolveStatus(query.status_id);
			if (query.assigned_to_id) query.assigned_to_id = await resolveUser(query.assigned_to_id);
			if (query.author_id) query.author_id = await resolveUser(query.author_id);
			return ok(await redmineRequest("/issues.json", { query }));
		}

		case "redmine_get_issue": {
			const include = args.include || "journals,attachments,children,relations,watchers";
			return ok(
				await redmineRequest(`/issues/${args.id}.json`, { query: { include } })
			);
		}

		case "redmine_create_issue": {
			const issue = { ...args };
			if (issue.project_id) issue.project_id = await resolveProject(issue.project_id);
			if (issue.tracker_id) issue.tracker_id = await resolveTracker(issue.tracker_id);
			if (issue.status_id) issue.status_id = await resolveStatus(issue.status_id);
			if (issue.priority_id) issue.priority_id = await resolvePriority(issue.priority_id);
			if (issue.assigned_to_id) issue.assigned_to_id = await resolveUser(issue.assigned_to_id);
			return ok(
				await redmineRequest("/issues.json", {
					method: "POST",
					body: { issue },
				})
			);
		}

		case "redmine_update_issue": {
			const { id, ...rest } = args;
			if (rest.tracker_id) rest.tracker_id = await resolveTracker(rest.tracker_id);
			if (rest.status_id) rest.status_id = await resolveStatus(rest.status_id);
			if (rest.priority_id) rest.priority_id = await resolvePriority(rest.priority_id);
			if (rest.assigned_to_id) rest.assigned_to_id = await resolveUser(rest.assigned_to_id);
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

		case "redmine_list_time_entries": {
			const query = { ...args };
			if (query.project_id) query.project_id = await resolveProject(query.project_id);
			return ok(await redmineRequest("/time_entries.json", { query }));
		}

		case "redmine_create_time_entry": {
			const entry = { ...args };
			if (entry.project_id) entry.project_id = await resolveProject(entry.project_id);
			return ok(
				await redmineRequest("/time_entries.json", {
					method: "POST",
					body: { time_entry: entry },
				})
			);
		}

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

function createMcpServer() {
	const server = new Server(
		{ name: "redmine-mcp", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			instructions: [
				"This server connects to Redmine, a project management and issue tracking system.",
				"Terminology: an 'issue' is the same thing as a ticket, bug, task, defect, feature request, or problem report. When the user says 'ticket', 'bug', 'task', or wants to 'report a problem', use the issue tools.",
				"To report a problem or file a ticket: use redmine_create_issue (needs a project and a subject). If you don't know the project, call redmine_list_projects first and pick the best match or ask the user.",
				"To find existing issues/tickets: use redmine_list_issues for filtered lists (by project, assignee, status, etc.) or redmine_search for free-text search. Use redmine_get_issue to read one issue in full, including its comment history.",
				"To comment on a ticket: use redmine_add_issue_note. To change status, assignee, priority, or other fields: use redmine_update_issue.",
				"Most filter fields accept human-friendly values: names, logins, emails, or 'me' — you do not need numeric ids.",
				"To log hours worked: use redmine_create_time_entry. To see who the current user is: redmine_current_user.",
				`Deep links: whenever you mention an issue/ticket to the user, include a clickable link of the form ${REDMINE_URL || "<redmine-url>"}/issues/<id> (e.g. after creating or finding a ticket). Link a project as ${REDMINE_URL || "<redmine-url>"}/projects/<identifier>, and a specific comment as ${REDMINE_URL || "<redmine-url>"}/issues/<id>#note-<n>.`,
			].join("\n"),
		}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: toolsForRequest(),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: rawArgs } = request.params;
		const args = { ...(rawArgs || {}) };
		const startedAt = Date.now();
		const client = reqCtx.getStore()?.client || {};
		// Filled in by dispatchToolCall once the effective identity is known.
		const audit = { user: "", mode: "" };
		let result;
		let failure = "";
		try {
			result = await dispatchToolCall(name, args, audit);
		} catch (e) {
			failure = e?.message || String(e);
			result = err(failure);
		}
		logEvent("call", {
			tool: name,
			user: audit.user || "-",
			mode: audit.mode,
			key: keyTag(),
			ip: client.ip,
			fwd: client.fwd,
			ua: client.ua,
			ms: Date.now() - startedAt,
			status: failure || result?.isError ? "error" : "ok",
			error: failure,
		});
		return result;
	});

	return server;
}

// Resolve the impersonation identity for a tool call and run it. `audit` is
// populated with the identity actually used so the caller can log who acted.
async function dispatchToolCall(name, args, audit) {
	// Resolve optional impersonation. A pinned identity (env lock or an
	// identity header) is authoritative and any caller-supplied on_behalf_of
	// is ignored; otherwise a per-call arg overrides the env default.
	const pinned = pinnedIdentity();
	const identity =
		pinned || (REDMINE_LOCK_ON_BEHALF_OF ? "" : args.on_behalf_of) || REDMINE_ON_BEHALF_OF || "";
	delete args.on_behalf_of;

	if (identity) {
		if (await ensureAdmin()) {
			const switchUser = await resolveLogin(identity);
			audit.user = switchUser;
			audit.mode = pinned ? "pinned" : "arg";
			return await withCtx({ switchUser }, () => handleTool(name, args));
		}
		// Non-admin key: impersonation is a no-op, act as the key owner.
		audit.user = identity;
		audit.mode = "key-owner";
		return await handleTool(name, args);
	}

	// No impersonation identity in effect. Fail closed if this would run as a
	// full admin, unless explicitly opted in via REDMINE_ALLOW_ADMIN. This stops
	// a misconfigured shared-admin-key deployment from silently executing calls
	// with admin privileges.
	if (!REDMINE_ALLOW_ADMIN && (await ensureAdmin())) {
		throw new Error(
			"Refusing to run with an admin API key and no impersonation identity. " +
				"Set REDMINE_ON_BEHALF_OF (and REDMINE_LOCK_ON_BEHALF_OF=1 for shared " +
				"deployments) to attribute actions to a specific user, or set " +
				"REDMINE_ALLOW_ADMIN=1 to intentionally act as the admin key owner."
		);
	}
	audit.mode = "key-owner";
	return await handleTool(name, args);
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// `Authorization: Bearer <redmine-api-key>` on the HTTP request overrides
// REDMINE_API_KEY for the lifetime of that request.
function bearerToken(req) {
	const header = req.headers?.authorization || "";
	const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
	return match ? match[1].trim() : "";
}

// The impersonation identity supplied by the transport: the first configured
// identity header present on the request wins (REDMINE_USER_HEADERS order). Node
// joins repeated headers with ", " — take the first value so a smuggled second
// identity cannot ride along. The header name is returned too, so the log shows
// which one the identity actually came from.
function onBehalfOfHeader(req) {
	for (const name of USER_HEADERS) {
		const value = String(req.headers?.[name] ?? "").split(",")[0].trim();
		if (value) return { name, value };
	}
	return { name: "", value: "" };
}

async function startHttp() {
	const port = HTTP_PORT || 3000;

	const httpServer = createHttpServer((req, res) => {
		const startedAt = Date.now();
		const client = clientInfo(req);
		const apiKey = bearerToken(req);
		const identity = onBehalfOfHeader(req);

		// One line per HTTP request, so transport-level traffic (initialize,
		// tools/list, rejected requests) is visible even when no tool runs.
		res.on("finish", () => {
			logEvent("http", {
				method: req.method,
				path: String(req.url || "").split("?")[0],
				user: identity.value || "-",
				via: identity.name,
				key: tagFor(apiKey || REDMINE_API_KEY),
				ip: client.ip,
				fwd: client.fwd,
				ua: client.ua,
				ms: Date.now() - startedAt,
				status: res.statusCode,
			});
		});

		// Stateless: a fresh Server + transport per request, so concurrent callers
		// with different bearer tokens never share state.
		const handle = async () => {
			const server = createMcpServer();
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
				enableDnsRebindingProtection: ALLOWED_HOSTS.length > 0,
				allowedHosts: ALLOWED_HOSTS.length > 0 ? ALLOWED_HOSTS : undefined,
			});
			res.on("close", () => {
				transport.close().catch(() => {});
				server.close().catch(() => {});
			});
			await server.connect(transport);
			await transport.handleRequest(req, res);
		};

		// AsyncLocalStorage propagates through the transport's async chain, so the
		// tool handlers see this request's credential, identity and origin.
		reqCtx
			.run({ apiKey, onBehalfOf: identity.value, client }, handle)
			.catch((e) => {
				console.error("[redmine-mcp] http request failed:", e);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
				}
				if (!res.writableEnded) {
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32603, message: "Internal server error" },
							id: null,
						})
					);
				}
			});
	});

	await new Promise((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, HTTP_HOST, resolve);
	});
	console.error(
		`[redmine-mcp] Streamable HTTP transport listening on http://${HTTP_HOST}:${port}/mcp`
	);
	console.error(
		`[redmine-mcp] impersonation identity headers (in order): ${USER_HEADERS.join(", ")}`
	);
}

async function startStdio() {
	const server = createMcpServer();
	await server.connect(new StdioServerTransport());
}

(HTTP_MODE ? startHttp() : startStdio()).catch((e) => {
	console.error("[redmine-mcp] fatal:", e);
	process.exit(1);
});
