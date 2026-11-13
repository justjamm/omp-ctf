/**
 * Contract with the real Oh My Pi SDK: tools must be admitted to restricted sessions and receive
 * the abort signal where the SDK passes it. A wrong execute() argument order made every ctf_* tool
 * fail at runtime while fake-SDK tests passed.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import type { CtfEvent } from "../src/view.ts";
import { CtfRun } from "../src/runtime.ts";
import { createHeadTools, HEAD_TOOL_NAMES } from "../src/tools.ts";
import { FakeDockerCli, tempStore, zod } from "./fakes.ts";

const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("ctf_* tools run through the real SDK tool adapter with a real AbortSignal", async () => {
	const agentDir = await fs.mkdtemp(path.join(tmpdir(), "omp-ctf-sdk-"));
	dirs.push(agentDir);
	const registry = new sdk.ModelRegistry(await sdk.discoverAuthStorage(agentDir));
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	expect(model).toBeDefined();
	const store = await tempStore();
	dirs.push(store.root);
	const events: CtfEvent[] = [];
	const run = new CtfRun(
		{ sdk, z: zod, docker: new FakeDockerCli().docker, store, modelRegistry: registry, ui: undefined, hostPaths: [], sessionCwd: store.root, onStatus: () => {}, onEvent: e => events.push(e) },
		{ eventId: "contract-abc123", eventName: "contract", headModel: model!, workerModels: [registry.find("anthropic", "claude-opus-4-5")!], config: { version: 1, workerModels: [], autoSubmit: false, maxWorkers: 1 } },
	);
	const { session } = await sdk.createAgentSession({
		cwd: store.root,
		agentDir,
		model,
		modelRegistry: registry,
		authStorage: registry.authStorage,
		sessionManager: sdk.SessionManager.inMemory(store.root),
		settings: sdk.Settings.isolated({ "memory.backend": "off" }),
		agentRegistry: new sdk.AgentRegistry(),
		bindProcessState: false,
		cacheWarming: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		toolNames: [...HEAD_TOOL_NAMES],
		customTools: createHeadTools(zod, run),
		systemPrompt: "contract",
	});
	try {
		expect(session.getEnabledToolNames().sort()).toEqual([...HEAD_TOOL_NAMES].sort());
		const dispatch = session.getToolByName("ctf_dispatch");
		expect(dispatch).toBeDefined();
		const updates: unknown[] = [];
		const result = await dispatch!.execute("call-1", { action: "status" }, new AbortController().signal, update => updates.push(update));
		const text = result.content.map(block => ("text" in block ? block.text : "")).join("");
		expect(text).not.toContain("AbortSignal");
		expect(JSON.parse(text)).toEqual([]);
	} finally {
		await session.dispose();
		await run.stop();
	}
}, 30_000);
