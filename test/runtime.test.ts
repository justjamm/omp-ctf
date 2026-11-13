import { describe, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { CtfRun, classifyHeadOutcome, ISOLATED_SETTINGS, type Sdk } from "../src/runtime.ts";
import type { CtfEvent } from "../src/view.ts";
import { HEAD_TOOL_NAMES, WORKER_TOOL_NAMES } from "../src/tools.ts";
import { FakeDockerCli, type FakeSession, fakeSdk, fakeUi, model, ok, tempStore, zod } from "./fakes.ts";

const HEAD = model("abl", "head-model");
const W1 = model("std", "worker-a");
const W2 = model("std", "worker-b");

/** Deterministic blocking points for fake worker sessions. */
class Gates {
	#waiting: Array<() => void> = [];
	#watchers: Array<() => void> = [];

	enter(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiting.push(resolve);
		for (const watcher of this.#watchers.splice(0)) watcher();
		return promise;
	}

	async waitForWaiting(count: number): Promise<void> {
		while (this.#waiting.length < count) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#watchers.push(resolve);
			await promise;
		}
	}

	releaseOne(): void {
		this.#waiting.shift()?.();
	}
}

async function makeRun(opts: { sdk: Sdk; ui?: ExtensionUIContext; maxWorkers?: number; autoSubmit?: boolean; cli?: FakeDockerCli }) {
	const cli = opts.cli ?? new FakeDockerCli();
	const store = await tempStore();
	const events: CtfEvent[] = [];
	const run = new CtfRun(
		{
			sdk: opts.sdk,
			z: zod,
			docker: cli.docker,
			store,
			modelRegistry: { authStorage: {} } as never,
			ui: opts.ui,
			hostPaths: ["/Users/op"],
			sessionCwd: store.root,
			onStatus: () => {},
			onEvent: event => events.push(event),
		},
		{
			eventId: "evt-abc123",
			eventName: "Test CTF",
			headModel: HEAD,
			workerModels: [W1, W2],
			config: { version: 1, workerModels: ["std/worker-a", "std/worker-b"], autoSubmit: opts.autoSubmit ?? false, maxWorkers: opts.maxWorkers ?? 4 },
		},
	);
	await run.startInfrastructure(() => {});
	return { run, cli, store, events };
}

function tool(session: FakeSession, name: string) {
	return (params: Record<string, unknown>) => session.call(name, params);
}

const driverCalls = (cli: FakeDockerCli) => cli.calls.filter(c => c.argv.includes("/opt/ctf-driver/driver.mjs"));

describe("model separation", () => {
	test("head may not be a worker model", async () => {
		const { sdk } = fakeSdk(async () => {});
		const store = await tempStore();
		expect(
			() =>
				new CtfRun(
					{ sdk, z: zod, docker: new FakeDockerCli().docker, store, modelRegistry: {} as never, ui: undefined, hostPaths: [], sessionCwd: store.root, onStatus: () => {}, onEvent: () => {} },
					{ eventId: "evt-abc123", eventName: "x", headModel: HEAD, workerModels: [HEAD], config: { version: 1, workerModels: [], autoSubmit: false, maxWorkers: 1 } },
				),
		).toThrow(/must not also be a worker/);
	});

	test("head and workers get isolated sessions with exact allowlists; workers never use the head model", async () => {
		const { sdk, sessions, options } = fakeSdk(async (session, text) => {
			if (session.model === HEAD) {
				const dispatch = tool(session, "ctf_dispatch");
				await dispatch({ action: "start", name: "pwn1" });
				await dispatch({ action: "start", name: "web1" });
				await dispatch({ action: "wait", timeoutSec: 5 });
			} else {
				session.lastText = `solved ${text.length}`;
			}
		});
		const { run } = await makeRun({ sdk });
		await run.beginHead("https://ctf.test/");
		const head = sessions.find(s => s.model === HEAD)!;
		const workers = sessions.filter(s => s !== head);
		expect(head.toolNames).toEqual([...HEAD_TOOL_NAMES]);
		expect(workers.map(w => w.model)).toEqual([W1, W2]);
		for (const w of workers) expect(w.toolNames).toEqual([...WORKER_TOOL_NAMES]);
		for (const o of options) {
			expect(o).toMatchObject({
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				bindProcessState: false,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				settings: { overrides: ISOLATED_SETTINGS },
			});
			expect(o.providerSessionId).toBeUndefined();
		}
		expect(new Set(options.map(o => o.agentRegistry)).size).toBe(options.length);
		expect(sessions.every(s => s.disposed)).toBe(true);
		expect(run.phase).toBe("finished");
	});

	test("a worker refusal is surfaced, never re-dispatched, and no session retries it", async () => {
		const { sdk, sessions } = fakeSdk(async session => {
			session.lastText = "REFUSED: not comfortable with this one";
		});
		const { run } = await makeRun({ sdk });
		const { challengeId } = await run.dispatch({ name: "rev1" });
		await run.waitFor([challengeId], 5000, run.signal);
		expect(run.summaries()[0]).toMatchObject({ status: "refused", model: "std/worker-a" });
		await expect(run.dispatch({ name: "REV1" })).rejects.toThrow(/refused.*final/);
		expect(sessions).toHaveLength(1);
		expect(sessions.some(s => s.model === HEAD)).toBe(false);
	});
});

describe("scheduling and isolation", () => {
	test("worker concurrency never exceeds maxWorkers and independent work proceeds", async () => {
		let active = 0;
		let peak = 0;
		const gates = new Gates();
		const { sdk } = fakeSdk(async session => {
			active++;
			peak = Math.max(peak, active);
			await gates.enter();
			active--;
			session.lastText = "done";
		});
		const { run } = await makeRun({ sdk, maxWorkers: 2 });
		const ids = [];
		for (let i = 0; i < 5; i++) ids.push((await run.dispatch({ name: `chal-${i}` })).challengeId);
		await gates.waitForWaiting(2);
		expect(active).toBe(2);
		for (let released = 0; released < 5; released++) {
			await gates.waitForWaiting(1);
			expect(active).toBeLessThanOrEqual(2);
			gates.releaseOne();
		}
		await run.waitFor(ids, 5000, run.signal);
		expect(peak).toBe(2);
		expect(run.summaries().every(s => s.status === "done")).toBe(true);
	});

	test("each worker's tools resolve only to its own container", async () => {
		const seen: Record<string, unknown> = {};
		const { sdk } = fakeSdk(async (session, text) => {
			const id = /Challenge id: (c-[a-f0-9]{8})/.exec(text)![1]!;
			await tool(session, "ctf_exec")({ argv: ["cat", "downloads/flag.txt"] });
			seen[id] = await tool(session, "ctf_submit_flag")({ flag: "x", inputSelector: "#f", submitSelector: "#s", challengeId: id === "c-00000000" ? "c-11111111" : "c-ffffffff" }).catch(e => (e as Error).message);
		});
		const { run, cli } = await makeRun({ sdk });
		const a = (await run.dispatch({ name: "a" })).challengeId;
		const b = (await run.dispatch({ name: "b" })).challengeId;
		await run.waitFor(undefined, 5000, run.signal);
		const execTargets = cli.calls.filter(c => c.argv[1] === "exec" && c.argv.includes("cat")).map(c => c.argv[c.argv.indexOf("timeout") - 1]);
		expect(execTargets.sort()).toEqual([`omp-ctf-evt-abc123-${a}`, `omp-ctf-evt-abc123-${b}`].sort());
		for (const id of [a, b]) expect(String(seen[id])).toMatch(/bound to/);
		const mounts = cli.calls.filter(c => c.argv[1] === "run" && c.argv.includes("-d") && c.argv.includes("/work")).map(c => c.argv.filter((_, i) => c.argv[i - 1] === "-v"));
		expect(mounts).toEqual([[`omp-ctf-evt-abc123-${a}-work:/work`], [`omp-ctf-evt-abc123-${b}-work:/work`]]);
	});

	test("ctf_exec and ctf_browser reject traversal, host paths and bad schemes before any container action", async () => {
		const results: string[] = [];
		const { sdk } = fakeSdk(async session => {
			const exec = tool(session, "ctf_exec");
			const browser = tool(session, "ctf_browser");
			for (const attempt of [
				() => exec({ argv: ["cat", "../../etc/passwd"] }),
				() => exec({ argv: ["cat", "/Users/op/.aws/credentials"] }),
				() => exec({ argv: ["ls"], cwd: "../other" }),
				() => browser({ op: "navigate", url: "file:///etc/passwd" }),
				() => browser({ op: "evaluate", expression: "document.cookie" }),
				() => browser({ op: "fill", selector: "#flag", value: "flag{abc}" }),
			]) {
				results.push(await attempt().then(() => "accepted", e => (e as Error).message));
			}
		});
		const { run, cli } = await makeRun({ sdk });
		await run.dispatch({ name: "x" });
		await run.waitFor(undefined, 5000, run.signal);
		expect(results.every(r => r !== "accepted")).toBe(true);
		expect(cli.calls.filter(c => c.argv[1] === "exec")).toHaveLength(0);
	});
});

describe("flag submission", () => {
	async function submitWith(ui: ExtensionUIContext | undefined, autoSubmit = false) {
		let result: unknown;
		const { sdk } = fakeSdk(async session => {
			result = await tool(session, "ctf_submit_flag")({ flag: "flag{x}", inputSelector: "#flag", submitSelector: "#go" });
		});
		const cli = new FakeDockerCli();
		cli.respond = argv => (argv.includes("/opt/ctf-driver/driver.mjs") ? ok('{"ok":true,"result":{"url":"https://ctf.test/"}}') : undefined);
		const { run } = await makeRun({ sdk, ui, autoSubmit, cli });
		await run.dispatch({ name: "crypto1" });
		await run.waitFor(undefined, 5000, run.signal);
		return { cli, result: JSON.stringify(result), run };
	}

	test("declined confirmation submits nothing", async () => {
		const { ui, log } = fakeUi({ confirm: () => false });
		const { cli, result } = await submitWith(ui);
		expect(log.confirm[0]?.message).toMatch(/Event: Test CTF[\s\S]*Challenge: crypto1[\s\S]*Flag: flag\{x\}/);
		expect(driverCalls(cli)).toHaveLength(0);
		expect(result).toMatch(/NOT SUBMITTED/);
	});

	test("no interactive UI submits nothing", async () => {
		const { cli, result } = await submitWith(undefined);
		expect(driverCalls(cli)).toHaveLength(0);
		expect(result).toMatch(/NOT SUBMITTED/);
	});

	test("approved confirmation submits exactly once", async () => {
		const { ui } = fakeUi({ confirm: () => true });
		const { cli, run } = await submitWith(ui);
		expect(driverCalls(cli)).toHaveLength(1);
		expect(run.summaries()[0]?.status).toBe("submitted");
	});
});

describe("cancellation", () => {
	test("stop aborts and disposes sessions, removes containers, keeps volumes; idempotent", async () => {
		const gates = new Gates();
		const { sdk, sessions } = fakeSdk(() => gates.enter());
		const { ui } = fakeUi();
		const { run, cli } = await makeRun({ sdk, ui });
		await run.dispatch({ name: "slow1" });
		await run.dispatch({ name: "slow2" });
		await gates.waitForWaiting(2);
		await Promise.all([run.stop(), run.stop()]);
		expect(sessions.every(s => s.aborted && s.disposed)).toBe(true);
		expect(run.summaries().every(s => s.status === "cancelled")).toBe(true);
		expect(cli.containers.size).toBe(0);
		expect(cli.calls.some(c => c.argv[1] === "volume" && c.argv[2] === "rm")).toBe(false);
		expect(cli.volumes.size).toBe(3);
		expect(run.ui()).toBeUndefined();
		await expect(run.dispatch({ name: "late" })).rejects.toThrow(/stopping/);
	});

	test("ask_user without a TUI errors instead of pretending", async () => {
		let message = "";
		const { sdk } = fakeSdk(async session => {
			message = await tool(session, "ctf_ask_user")({ question: "captcha?" }).then(() => "answered", e => (e as Error).message);
		});
		const { run } = await makeRun({ sdk });
		await run.dispatch({ name: "q" });
		await run.waitFor(undefined, 5000, run.signal);
		expect(message).toMatch(/NOT asked/);
	});
});

describe("run outcome and main-session events", () => {
	test("a head whose every tool call fails ends as failed with the first error, not finished", async () => {
		const { sdk } = fakeSdk(async session => {
			for (let i = 0; i < 3; i++) await session.call("ctf_browser", { op: "navigate", url: "file:///etc/passwd" }).catch(() => {});
			session.lastText = "The tools are broken.";
		});
		const { run, events } = await makeRun({ sdk });
		await run.beginHead("https://ctf.test/");
		expect(run.phase).toBe("failed");
		expect(run.headError).toMatch(/None of the head's 3 tool calls succeeded.*ctf_browser: .*not allowed/);
		const failed = events.find(e => e.kind === "failed")!;
		expect(failed.lines.join("\n")).toContain("None of the head's 3 tool calls succeeded");
		expect(failed.untrusted).toContain("The tools are broken.");
	});

	test("a provider error in the head is reported as the failure reason", () => {
		const outcome = classifyHeadOutcome(
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "Unsupported service_tier: flex" }] as never, getLastAssistantText: () => undefined },
			{ ok: 0, failed: 0 },
		);
		expect(outcome).toEqual({ phase: "failed", error: "Head model error: Unsupported service_tier: flex", summary: "" });
	});

	test("events tell the main session what happened, with model/site output marked untrusted", async () => {
		const { sdk } = fakeSdk(async (session, text) => {
			if (session.model === HEAD) {
				await session.call("ctf_dispatch", { action: "start", name: "pwn1", description: "Exploit the service" });
				await session.call("ctf_dispatch", { action: "wait", timeoutSec: 5 });
				session.lastText = "pwn1 solved by the worker.";
			} else {
				session.lastText = `Found flag{demo} for ${/Challenge: (.*)/.exec(text)?.[1]}`;
			}
		});
		const { run, events } = await makeRun({ sdk });
		await run.beginHead("https://ctf.test/");
		expect(run.phase).toBe("finished");
		expect(events.map(e => e.kind)).toEqual(["started", "dispatched", "worker", "finished"]);
		expect(events[0]!.lines.join("\n")).toContain("Head: abl/head-model");
		expect(events[1]!.untrusted).toBe("Exploit the service");
		expect(events[2]).toMatchObject({ tone: "success", untrusted: "Found flag{demo} for pwn1" });
		expect(events[3]!.untrusted).toContain("pwn1 solved by the worker.");
		expect(events.every(e => e.eventId === "evt-abc123")).toBe(true);
	});

	test("a confirmed submission is reported with its flag", async () => {
		const { ui } = fakeUi({ confirm: () => true });
		const cli = new FakeDockerCli();
		const { sdk } = fakeSdk(async session => {
			await session.call("ctf_submit_flag", { flag: "flag{x}", inputSelector: "#flag", submitSelector: "#go" });
		});
		const { run, events } = await makeRun({ sdk, ui, cli });
		await run.dispatch({ name: "crypto1" });
		await run.waitFor(undefined, 5000, run.signal);
		const submitted = events.find(e => e.kind === "submitted")!;
		expect(submitted.lines).toContain("Flag: flag{x}");
	});
});
