/** Validation shared by host tools, the Docker boundary, and tests. All checks fail closed. */
import { randomBytes } from "node:crypto";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const MAX_NAV_TIMEOUT_MS = 120_000;
export const DEFAULT_EXEC_TIMEOUT_SEC = 120;
export const MAX_EXEC_TIMEOUT_SEC = 1800;
export const MAX_SELECTOR_LENGTH = 2000;
export const MAX_FILL_LENGTH = 10_000;

export class ValidationError extends Error {
	override name = "ValidationError";
}

const EVENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHALLENGE_ID = /^c-[a-f0-9]{8}$/;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function assertEventId(id: string): string {
	if (!EVENT_ID.test(id)) throw new ValidationError(`Invalid event id: ${JSON.stringify(id)}`);
	return id;
}

export function assertChallengeId(id: string): string {
	if (!CHALLENGE_ID.test(id)) throw new ValidationError(`Invalid challenge id: ${JSON.stringify(id)}`);
	return id;
}

export function assertPageId(id: string): string {
	if (!PAGE_ID.test(id)) throw new ValidationError(`Invalid page id: ${JSON.stringify(id)}`);
	return id;
}

export function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

export function newChallengeId(): string {
	return `c-${randomHex(4)}`;
}

/** Normalized slug from a free-form event name plus a random suffix. */
export function newEventId(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return assertEventId(`${slug || "event"}-${randomHex(3)}`);
}

/** Only http(s) URLs with a host; credentials embedded in URLs are rejected. */
export function assertHttpUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ValidationError(`Invalid URL: ${JSON.stringify(raw)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ValidationError(`URL scheme ${JSON.stringify(url.protocol)} is not allowed; only http: and https:`);
	}
	if (!url.hostname) throw new ValidationError("URL has no host");
	if (url.username || url.password) throw new ValidationError("URLs with embedded credentials are not allowed");
	return url;
}

export function clampTimeoutMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_NAV_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0) throw new ValidationError("timeoutMs must be a positive number");
	return Math.min(Math.floor(value), MAX_NAV_TIMEOUT_MS);
}

export function clampExecTimeoutSec(value: number | undefined): number {
	if (value === undefined) return DEFAULT_EXEC_TIMEOUT_SEC;
	if (!Number.isFinite(value) || value <= 0) throw new ValidationError("timeoutSec must be a positive number");
	return Math.min(Math.floor(value), MAX_EXEC_TIMEOUT_SEC);
}

export function assertSelector(selector: unknown): string {
	if (typeof selector !== "string" || selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) {
		throw new ValidationError(`selector must be a non-empty string up to ${MAX_SELECTOR_LENGTH} chars`);
	}
	if (selector.includes("\0")) throw new ValidationError("selector contains NUL");
	// Playwright selector engines that evaluate page JavaScript are not allowed.
	if (/^\s*(js|javascript|eval)\s*=/i.test(selector) || /(^|>>)\s*(js|javascript|eval)\s*=/i.test(selector)) {
		throw new ValidationError("JavaScript selector engines are not allowed");
	}
	return selector;
}

/**
 * Workspace-relative path inside /work. Rejects absolute paths, NUL, backslashes and `..` segments.
 * Returns the normalized relative path ("" for the workspace root).
 */
export function assertWorkspaceRelative(raw: string): string {
	if (typeof raw !== "string" || raw.includes("\0") || raw.includes("\\")) {
		throw new ValidationError(`Invalid workspace path: ${JSON.stringify(raw)}`);
	}
	if (raw.startsWith("/") || raw.startsWith("~")) {
		throw new ValidationError(`Path must be workspace-relative: ${JSON.stringify(raw)}`);
	}
	const parts = raw.split("/").filter(part => part !== "" && part !== ".");
	if (parts.some(part => part === "..")) {
		throw new ValidationError(`Path traversal is not allowed: ${JSON.stringify(raw)}`);
	}
	return parts.join("/");
}

/** Container-side absolute prefixes an argv element may name. */
const CONTAINER_PATH_PREFIXES = ["/work", "/usr", "/bin", "/sbin", "/lib", "/opt", "/tmp", "/home/ctf", "/proc/self", "/dev/null", "/etc"];
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * argv for execution inside a challenge container. Elements must be strings without NUL;
 * path-like elements may not traverse with `..`, and absolute paths must name container locations,
 * never host locations such as the operator's home directory.
 */
export function assertExecArgv(argv: unknown, hostPaths: readonly string[] = []): string[] {
	if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256) {
		throw new ValidationError("argv must be a non-empty array of at most 256 strings");
	}
	return argv.map((arg, index) => {
		if (typeof arg !== "string" || arg.includes("\0") || arg.length > 65_536) {
			throw new ValidationError(`argv[${index}] must be a string without NUL`);
		}
		if (URL_LIKE.test(arg)) return arg;
		const candidate = arg.includes("=") && !arg.startsWith("/") ? arg.slice(arg.indexOf("=") + 1) : arg;
		if (/(^|\/)\.\.(\/|$)/.test(candidate)) {
			throw new ValidationError(`argv[${index}] contains path traversal: ${JSON.stringify(arg)}`);
		}
		for (const hostPath of hostPaths) {
			if (hostPath && hostPath !== "/" && (candidate === hostPath || candidate.startsWith(`${hostPath}/`))) {
				throw new ValidationError(`argv[${index}] names a host path: ${JSON.stringify(arg)}`);
			}
		}
		if (candidate.startsWith("/")) {
			const allowed = CONTAINER_PATH_PREFIXES.some(prefix => candidate === prefix || candidate.startsWith(`${prefix}/`));
			if (!allowed) throw new ValidationError(`argv[${index}] names a path outside the container workspace: ${JSON.stringify(arg)}`);
		}
		return arg;
	});
}

/** Truncate a string to a UTF-8 byte cap, appending a marker when truncated. */
export function capText(text: string, maxBytes: number = MAX_TEXT_BYTES): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return text;
	const marker = `\n…[truncated ${bytes - maxBytes} bytes]`;
	const buffer = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker)));
	// Drop a split trailing multi-byte sequence.
	return buffer.toString("utf8").replace(/\uFFFD$/, "") + marker;
}

/** Looks like a CTF flag (e.g. `flag{...}`); used to route flag entry through ctf_submit_flag. */
export function looksLikeFlag(value: string): boolean {
	return /[A-Za-z0-9_-]{2,32}\{[^{}\s]{1,512}\}/.test(value);
}
