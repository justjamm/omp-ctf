import { describe, expect, test } from "bun:test";
import { safeFileName, validateRequest } from "../docker/browser/driver.mjs";
import { CtfStore } from "../src/config.ts";
import { assertExecArgv, assertHttpUrl, assertSelector, assertWorkspaceRelative, capText, MAX_NAV_TIMEOUT_MS } from "../src/validate.ts";
import { tempStore } from "./fakes.ts";
import * as fs from "node:fs/promises";

describe("exec argv boundary", () => {
	test("rejects traversal, including inside option values", () => {
		expect(() => assertExecArgv(["cat", "../secret"])).toThrow(/traversal/);
		expect(() => assertExecArgv(["cat", "downloads/../../etc"])).toThrow(/traversal/);
		expect(() => assertExecArgv(["tar", "--file=../x.tar"])).toThrow(/traversal/);
	});

	test("rejects host paths and absolute paths outside container locations", () => {
		expect(() => assertExecArgv(["cat", "/Users/op/.ssh/id_rsa"], ["/Users/op"])).toThrow(/host path/);
		expect(() => assertExecArgv(["ls", "/var/run/docker.sock"])).toThrow(/outside the container/);
	});

	test("allows workspace and container tool paths, flags and URLs", () => {
		expect(assertExecArgv(["/usr/bin/python3", "solve.py", "/work/downloads/a.bin", "-v", "https://x.test/a/../b"])).toHaveLength(5);
	});

	test("rejects empty or non-string argv", () => {
		expect(() => assertExecArgv([])).toThrow();
		expect(() => assertExecArgv(["ls", 3])).toThrow();
		expect(() => assertExecArgv(["ls\0"])).toThrow();
	});
});

describe("workspace paths", () => {
	test("normalizes relative paths and rejects escapes", () => {
		expect(assertWorkspaceRelative("./a//b/")).toBe("a/b");
		for (const bad of ["../a", "a/../../b", "/etc", "~/x", "a\\..\\b"]) expect(() => assertWorkspaceRelative(bad)).toThrow();
	});
});

describe("URLs and selectors", () => {
	test("host and driver accept only http(s)", () => {
		expect(assertHttpUrl("https://ctf.test/x").href).toBe("https://ctf.test/x");
		for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "https://u:p@ctf.test/"]) {
			expect(() => assertHttpUrl(bad)).toThrow();
			expect(() => validateRequest({ op: "navigate", pageId: "head", url: bad })).toThrow();
		}
	});

	test("JavaScript selector engines are rejected on both sides", () => {
		expect(() => assertSelector("js=document.body")).toThrow();
		expect(() => validateRequest({ op: "click", pageId: "head", selector: "div >> javascript=1" })).toThrow();
		expect(assertSelector("role=button[name='Submit']")).toBeTruthy();
	});

	test("driver rejects unknown operations (no evaluate/CDP) and bad page ids, clamps timeouts", () => {
		expect(() => validateRequest({ op: "evaluate", pageId: "head", expression: "1" })).toThrow(/unknown operation/);
		expect(() => validateRequest({ op: "observe", pageId: "../x" })).toThrow(/pageId/);
		expect(validateRequest({ op: "observe", pageId: "c-1234abcd", timeoutMs: 10_000_000 }).timeoutMs).toBe(MAX_NAV_TIMEOUT_MS);
	});

	test("download file names cannot traverse", () => {
		expect(safeFileName("../../etc/passwd")).toBe("passwd");
		expect(safeFileName("..")).toBe("download");
	});
});

describe("output caps", () => {
	test("capText never exceeds the byte cap", () => {
		const out = capText("é".repeat(2_000_000), 1024 * 1024);
		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1024 * 1024);
		expect(out).toContain("truncated");
	});
});

describe("config", () => {
	test("malformed config errors until reset; config dir is owner-only", async () => {
		const store = await tempStore();
		expect(await store.loadConfig()).toBeUndefined();
		await fs.mkdir(store.root, { recursive: true });
		await fs.writeFile(store.configPath, "{nope");
		await expect(store.loadConfig()).rejects.toThrow(/reset-config/);
		await expect(store.saveConfig({ version: 1, workerModels: [], autoSubmit: false, maxWorkers: 9 })).rejects.toThrow(/maxWorkers/);
		const fresh = await store.resetConfig();
		expect(fresh).toEqual({ version: 1, workerModels: [], autoSubmit: false, maxWorkers: 4 });
		expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(store.configPath)).mode & 0o777).toBe(0o600);
		expect(store).toBeInstanceOf(CtfStore);
	});
});
