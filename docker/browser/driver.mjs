// Fixed browser operation surface for the omp-ctf browser container.
//   node driver.mjs serve  — owns the headed persistent Chromium context; listens on a private Unix socket.
//   node driver.mjs call   — reads one JSON request on stdin, forwards it, prints one JSON response.
// There is no operation that evaluates page JavaScript, speaks CDP, or touches arbitrary paths.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export const OPS = Object.freeze([
	"navigate",
	"observe",
	"click",
	"fill",
	"press",
	"back",
	"forward",
	"screenshot",
	"download",
	"listChallenges",
	"submit",
]);
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const SOCKET = "/tmp/ctf/driver.sock";
const PROFILE_DIR = "/home/ctf/profile";
const DOWNLOAD_DIR = "/home/ctf/downloads";
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z0-9+]{1,32}$/;
const ROLES = new Set([
	"button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "option", "tab", "tabpanel",
	"menuitem", "heading", "cell", "row", "dialog", "searchbox", "switch", "img", "navigation", "article", "listitem",
]);

export class RequestError extends Error {}

function fail(message) {
	throw new RequestError(message);
}

function checkUrl(raw) {
	let url;
	try {
		url = new URL(String(raw));
	} catch {
		fail(`invalid URL ${JSON.stringify(raw)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") fail(`URL scheme ${url.protocol} is not allowed`);
	if (url.username || url.password) fail("URLs with embedded credentials are not allowed");
	return url.href;
}

function checkSelector(selector) {
	if (typeof selector !== "string" || selector.length === 0 || selector.length > 2000 || selector.includes("\0")) {
		fail("selector must be a non-empty string up to 2000 chars");
	}
	if (/(^|>>)\s*(js|javascript|eval)\s*=/i.test(selector)) fail("JavaScript selector engines are not allowed");
	return selector;
}

function checkTimeout(value) {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail("timeoutMs must be a positive number");
	return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function checkTarget(req) {
	if (req.selector !== undefined) return { selector: checkSelector(req.selector) };
	if (req.role !== undefined) {
		if (!ROLES.has(req.role)) fail(`unsupported role ${JSON.stringify(req.role)}`);
		if (req.name !== undefined && (typeof req.name !== "string" || req.name.length > 500)) fail("name must be a string up to 500 chars");
		return { role: req.role, name: req.name };
	}
	if (req.text !== undefined) {
		if (typeof req.text !== "string" || req.text.length === 0 || req.text.length > 500) fail("text must be a string up to 500 chars");
		return { text: req.text };
	}
	fail("a target is required: selector, role (+ name) or text");
}

/** Validate and normalize a request. Exported for tests; the server re-validates every call. */
export function validateRequest(req) {
	if (!req || typeof req !== "object" || Array.isArray(req)) fail("request must be an object");
	if (!OPS.includes(req.op)) fail(`unknown operation ${JSON.stringify(req.op)}`);
	if (typeof req.pageId !== "string" || !PAGE_ID.test(req.pageId)) fail("invalid pageId");
	const out = { op: req.op, pageId: req.pageId, timeoutMs: checkTimeout(req.timeoutMs) };
	switch (req.op) {
		case "navigate":
			out.url = checkUrl(req.url);
			break;
		case "click":
			out.target = checkTarget(req);
			break;
		case "fill":
			out.target = checkTarget(req);
			if (typeof req.value !== "string" || req.value.length > 10_000) fail("value must be a string up to 10000 chars");
			out.value = req.value;
			break;
		case "press":
			if (typeof req.key !== "string" || !KEY.test(req.key)) fail("invalid key");
			out.key = req.key;
			if (req.selector !== undefined || req.role !== undefined || req.text !== undefined) out.target = checkTarget(req);
			break;
		case "screenshot":
			out.fullPage = req.fullPage === true;
			break;
		case "download":
			if (req.url !== undefined) out.url = checkUrl(req.url);
			else out.target = checkTarget(req);
			break;
		case "submit":
			out.input = { selector: checkSelector(req.inputSelector) };
			out.submit = { selector: checkSelector(req.submitSelector) };
			if (typeof req.flag !== "string" || req.flag.length === 0 || req.flag.length > 1000) fail("flag must be a non-empty string");
			out.flag = req.flag;
			break;
		default:
			break;
	}
	return out;
}

export function capText(text, max = MAX_TEXT_BYTES) {
	const buf = Buffer.from(String(text), "utf8");
	if (buf.byteLength <= max) return String(text);
	return `${buf.subarray(0, max - 64).toString("utf8")}\n…[truncated ${buf.byteLength - max} bytes]`;
}

export function safeFileName(raw) {
	const base = path.basename(String(raw || "download")).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
	return (base || "download").slice(0, 120);
}

// ---------------------------------------------------------------- server

async function serve() {
	const { chromium } = await import("playwright");
	fs.mkdirSync(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
	const context = await chromium.launchPersistentContext(PROFILE_DIR, {
		headless: false,
		acceptDownloads: true,
		viewport: null,
		args: ["--no-first-run", "--no-default-browser-check", "--start-maximized"],
	});
	const pages = new Map();
	const initial = context.pages()[0] ?? (await context.newPage());
	pages.set("head", initial);

	const isWeb = p => /^https?:/.test(p.url());

	async function page(pageId) {
		let p = pages.get(pageId);
		// The operator navigates and signs in by hand, possibly in a tab they opened. Until the head
		// tab shows a website, adopt the most recent operator tab that does and is not a worker's.
		if (pageId === "head" && (!p || p.isClosed() || !isWeb(p))) {
			const owned = new Set([...pages].filter(([id]) => id !== "head").map(([, page]) => page));
			const candidate = context.pages().filter(page => !owned.has(page) && !page.isClosed() && isWeb(page)).at(-1);
			if (candidate) {
				p = candidate;
				pages.set("head", p);
			}
		}
		if (!p || p.isClosed()) {
			p = await context.newPage();
			pages.set(pageId, p);
		}
		return p;
	}

	function locate(p, target) {
		if (target.selector) return p.locator(target.selector).first();
		if (target.role) return p.getByRole(target.role, target.name ? { name: target.name } : {}).first();
		return p.getByText(target.text).first();
	}

	async function uniqueDownloadPath(name) {
		const safe = safeFileName(name);
		let candidate = path.join(DOWNLOAD_DIR, safe);
		for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(DOWNLOAD_DIR, `${i}-${safe}`);
		return candidate;
	}

	async function handle(req) {
		const p = await page(req.pageId);
		switch (req.op) {
			case "navigate": {
				const response = await p.goto(req.url, { timeout: req.timeoutMs, waitUntil: "domcontentloaded" });
				return { url: p.url(), title: await p.title(), status: response?.status() ?? null };
			}
			case "observe": {
				const snapshot = await p.locator("body").ariaSnapshot({ timeout: req.timeoutMs });
				return { url: p.url(), title: await p.title(), snapshot: capText(snapshot, MAX_TEXT_BYTES - 4096) };
			}
			case "click":
				await locate(p, req.target).click({ timeout: req.timeoutMs });
				await p.waitForLoadState("domcontentloaded", { timeout: req.timeoutMs }).catch(() => {});
				return { url: p.url(), title: await p.title() };
			case "fill":
				await locate(p, req.target).fill(req.value, { timeout: req.timeoutMs });
				return { ok: true };
			case "press":
				if (req.target) await locate(p, req.target).press(req.key, { timeout: req.timeoutMs });
				else await p.keyboard.press(req.key);
				return { url: p.url() };
			case "back":
				await p.goBack({ timeout: req.timeoutMs });
				return { url: p.url(), title: await p.title() };
			case "forward":
				await p.goForward({ timeout: req.timeoutMs });
				return { url: p.url(), title: await p.title() };
			case "screenshot": {
				let quality = 70;
				let image = await p.screenshot({ type: "jpeg", quality, fullPage: req.fullPage, timeout: req.timeoutMs });
				while (image.byteLength * 1.4 > MAX_TEXT_BYTES - 4096 && quality > 20) {
					quality -= 20;
					image = await p.screenshot({ type: "jpeg", quality, fullPage: false, timeout: req.timeoutMs });
				}
				if (image.byteLength * 1.4 > MAX_TEXT_BYTES - 4096) fail("screenshot exceeds output cap");
				return { mimeType: "image/jpeg", data: image.toString("base64"), url: p.url() };
			}
			case "download": {
				if (req.url) {
					const response = await context.request.get(req.url, { timeout: req.timeoutMs, maxRedirects: 5 });
					if (!response.ok()) fail(`download failed with HTTP ${response.status()}`);
					const declared = Number(response.headers()["content-length"] ?? 0);
					if (declared > MAX_DOWNLOAD_BYTES) fail(`download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
					const body = await response.body();
					if (body.byteLength > MAX_DOWNLOAD_BYTES) fail(`download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
					const disposition = response.headers()["content-disposition"] ?? "";
					const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
					const file = await uniqueDownloadPath(named ? decodeURIComponent(named) : new URL(req.url).pathname);
					fs.writeFileSync(file, body, { mode: 0o600 });
					return { path: file, name: path.basename(file), bytes: body.byteLength };
				}
				const [download] = await Promise.all([
					p.waitForEvent("download", { timeout: req.timeoutMs }),
					locate(p, req.target).click({ timeout: req.timeoutMs }),
				]);
				const file = await uniqueDownloadPath(download.suggestedFilename());
				await download.saveAs(file);
				const { size } = fs.statSync(file);
				if (size > MAX_DOWNLOAD_BYTES) {
					fs.rmSync(file, { force: true });
					fail(`download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
				}
				return { path: file, name: path.basename(file), bytes: size };
			}
			case "listChallenges": {
				// Accessibility-derived candidates: links and buttons with visible names. Untrusted data.
				const items = [];
				for (const role of ["link", "button"]) {
					const loc = p.getByRole(role);
					const count = Math.min(await loc.count(), 400);
					for (let i = 0; i < count; i++) {
						const el = loc.nth(i);
						const name = ((await el.textContent({ timeout: 2000 }).catch(() => "")) ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
						if (!name) continue;
						const href = role === "link" ? await el.getAttribute("href", { timeout: 2000 }).catch(() => null) : null;
						items.push({ role, name, href });
					}
				}
				return { url: p.url(), candidates: items.slice(0, 600) };
			}
			case "submit": {
				await p.locator(req.input.selector).first().fill(req.flag, { timeout: req.timeoutMs });
				await p.locator(req.submit.selector).first().click({ timeout: req.timeoutMs });
				await p.waitForTimeout(1500);
				const snapshot = await p.locator("body").ariaSnapshot({ timeout: req.timeoutMs }).catch(() => "");
				return { url: p.url(), snapshot: capText(snapshot, 32 * 1024) };
			}
			default:
				fail("unreachable");
		}
	}

	fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
	fs.rmSync(SOCKET, { force: true });
	const server = net.createServer(socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			if (buffer.length > MAX_REQUEST_BYTES) socket.destroy();
			const nl = buffer.indexOf("\n");
			if (nl < 0) return;
			const line = buffer.slice(0, nl);
			void (async () => {
				let reply;
				try {
					reply = { ok: true, result: await handle(validateRequest(JSON.parse(line))) };
				} catch (error) {
					reply = { ok: false, error: capText(error instanceof Error ? error.message : String(error), 8192) };
				}
				socket.end(`${JSON.stringify(reply)}\n`);
			})();
		});
	});
	server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
	const shutdown = async () => {
		server.close();
		await context.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

// ---------------------------------------------------------------- client

async function call() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
			return;
		}
		chunks.push(chunk);
	}
	let request;
	try {
		request = validateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
		return;
	}
	const reply = await new Promise(resolve => {
		const socket = net.createConnection(SOCKET);
		let data = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", chunk => {
			data += chunk;
		});
		socket.on("end", () => resolve(data.trim() || JSON.stringify({ ok: false, error: "empty driver reply" })));
		socket.on("error", error => resolve(JSON.stringify({ ok: false, error: `driver unavailable: ${error.message}` })));
	});
	process.stdout.write(`${reply}\n`);
}

const mode = process.argv[2];
if (import.meta.main ?? process.argv[1]?.endsWith("driver.mjs")) {
	if (mode === "serve") await serve();
	else if (mode === "call") await call();
}
