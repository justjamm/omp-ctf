/** Fakes for Docker, TUI and the SDK used by behavioral tests. No real containers or models. */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as z from "@oh-my-pi/omptype/zod";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui";
import { CtfStore } from "../src/config.ts";
import { Docker, type PipeRunner, type RunOptions, type RunResult } from "../src/docker.ts";
import type { Model, Sdk } from "../src/runtime.ts";
import type { Zod } from "../src/tools.ts";

export const zod = z as unknown as Zod;

export function ok(stdout = ""): RunResult {
	return { code: 0, stdout, stderr: "", truncated: false, timedOut: false, aborted: false };
}

export interface Call {
	argv: string[];
	options?: RunOptions;
}

/** Records every docker argv; `respond` decides the result. */
export class FakeDockerCli {
	calls: Call[] = [];
	pipes: Array<{ from: readonly string[]; to: readonly string[] }> = [];
	volumes = new Map<string, string>(); // name -> event label
	containers = new Map<string, string>(); // name -> event label
	respond: (argv: string[], options?: RunOptions) => RunResult | undefined = () => undefined;
	pipeResult = { fromCode: 0, toCode: 0, bytes: 10, stderr: "", exceeded: false };
	hasCli = true;
	/** URLs the fake browser reports for successive driver calls (the last one repeats). */
	pageUrls = ["https://ctf.test/challenges"];

	readonly docker = new Docker(
		async (argv, options) => this.#run([...argv], options),
		(async (from, to) => {
			this.pipes.push({ from, to });
			return this.pipeResult;
		}) as PipeRunner,
		() => (this.hasCli ? "/usr/bin/docker" : null),
	);

	#label(argv: string[]): string | undefined {
		const i = argv.findIndex((a, idx) => argv[idx - 1] === "--label" && a.startsWith("omp-ctf.event="));
		return i >= 0 ? argv[i]?.slice("omp-ctf.event=".length) : undefined;
	}

	async #run(argv: string[], options?: RunOptions): Promise<RunResult> {
		this.calls.push({ argv, options });
		const custom = this.respond(argv, options);
		if (custom) return custom;
		if (argv.includes("/opt/ctf-driver/driver.mjs")) {
			const url = this.pageUrls.length > 1 ? this.pageUrls.shift() : this.pageUrls[0];
			return ok(JSON.stringify({ ok: true, result: { url, title: "page" } }));
		}
		const [, cmd, sub] = argv;
		if (cmd === "info") return ok("27.0.0");
		if (cmd === "image") return ok("sha256:x");
		if (cmd === "volume" && sub === "inspect") return this.volumes.has(argv.at(-1) ?? "") ? ok(argv.at(-1)) : { ...ok(), code: 1, stderr: "no such volume" };
		if (cmd === "volume" && sub === "create") {
			this.volumes.set(argv.at(-1) ?? "", this.#label(argv) ?? "");
			return ok(argv.at(-1));
		}
		if (cmd === "volume" && sub === "rm") {
			this.volumes.delete(argv.at(-1) ?? "");
			return ok();
		}
		if (cmd === "volume" && sub === "ls") {
			const event = argv.at(-1)?.split("=").at(-1);
			return ok([...this.volumes].filter(([, e]) => e === event).map(([n]) => n).join("\n"));
		}
		if (cmd === "ps") {
			const event = argv.at(-1)?.split("=").at(-1);
			return ok([...this.containers].filter(([, e]) => e === event).map(([n]) => n).join("\n"));
		}
		if (cmd === "run" && argv.includes("-d")) {
			const name = argv[argv.indexOf("--name") + 1] ?? "";
			this.containers.set(name, this.#label(argv) ?? "");
			return ok("cid");
		}
		if (cmd === "rm") {
			this.containers.delete(argv.at(-1) ?? "");
			return ok();
		}
		if (cmd === "port") return ok("127.0.0.1:49999\n");
		if (cmd === "run" && argv.includes("--rm") && argv.includes("find")) return ok("./flag.txt\n./notes\n./notes/a.md\n");
		return ok();
	}

	byCommand(cmd: string): Call[] {
		return this.calls.filter(call => call.argv[1] === cmd);
	}
}

export interface FakeUiOptions {
	select?: (title: string, options: string[]) => string | undefined;
	confirm?: (title: string, message: string) => boolean;
	input?: (title: string) => string | undefined;
}

/** Theme stand-in that applies no styling, so rendered components are plain text. */
export const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

export function fakeUi(opts: FakeUiOptions = {}) {
	const log = {
		notify: [] as string[],
		select: [] as Array<{ title: string; options: string[] }>,
		confirm: [] as Array<{ title: string; message: string }>,
		input: [] as string[],
		status: [] as Array<string | undefined>,
		widget: [] as unknown[],
	};
	const ui = {
		select: async (title: string, options: unknown[]) => {
			const labels = options.map(o => (typeof o === "string" ? o : o && typeof o === "object" && "label" in o ? String(o.label) : String(o)));
			log.select.push({ title, options: labels });
			return opts.select?.(title, labels);
		},
		confirm: async (title: string, message: string) => {
			log.confirm.push({ title, message });
			return opts.confirm?.(title, message) ?? false;
		},
		input: async (title: string) => {
			log.input.push(title);
			return opts.input?.(title);
		},
		notify: (message: string) => {
			log.notify.push(message);
		},
		setStatus: (_key: string, text: string | undefined) => {
			log.status.push(text);
		},
		setWidget: (_key: string, content: unknown) => {
			log.widget.push(content);
		},
		theme: plainTheme,
	} as unknown as ExtensionUIContext;
	return { ui, log };
}

export function model(provider: string, id: string): Model {
	return { provider, id } as unknown as Model;
}

type FakeListener = (event: Record<string, unknown>) => void;

export interface FakeSession {
	model: Model;
	toolNames: string[];
	tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
	prompts: string[];
	aborted: boolean;
	disposed: boolean;
	messages: Array<Record<string, unknown>>;
	lastText: string;
	listeners: FakeListener[];
	/**
	 * Invoke a tool the way the real SDK adapter calls SDK custom tools — CustomTool order
	 * `(toolCallId, params, onUpdate, ctx, signal)` — emitting tool_execution_start/end events.
	 * Throws like a failed tool call so behaviors can observe the error.
	 */
	call(name: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Fake SDK: createAgentSession records options and returns a session whose `prompt` runs `behavior`.
 * Mirrors restricted admission by enabling exactly the supplied toolNames.
 */
export function fakeSdk(behavior: (session: FakeSession, text: string) => Promise<void>) {
	const sessions: FakeSession[] = [];
	const options: Array<Record<string, unknown>> = [];
	const promptWatchers: Array<() => void> = [];
	/** Resolves once `count` prompts have been sent across all sessions. */
	const waitForPrompts = async (count: number) => {
		while (sessions.reduce((n, s) => n + s.prompts.length, 0) < count) {
			const { promise, resolve } = Promise.withResolvers<void>();
			promptWatchers.push(resolve);
			await promise;
		}
	};
	const sdk = {
		Settings: { isolated: (overrides: Record<string, unknown>) => ({ overrides }) },
		SessionManager: { inMemory: (cwd: string) => ({ inMemory: cwd }) },
		AgentRegistry: class {},
		createAgentSession: async (opts: Record<string, unknown>) => {
			options.push(opts);
			const state: FakeSession = {
				model: opts.model as Model,
				toolNames: opts.toolNames as string[],
				tools: opts.customTools as FakeSession["tools"],
				prompts: [],
				aborted: false,
				disposed: false,
				messages: [],
				lastText: "",
				listeners: [],
				async call(name, params) {
					const tool = state.tools.find(t => t.name === name);
					if (!tool) throw new Error(`no tool ${name}`);
					const emit = (event: Record<string, unknown>) => {
						for (const listener of state.listeners) listener(event);
					};
					emit({ type: "tool_execution_start", toolCallId: "call", toolName: name, args: params });
					try {
						const result = await tool.execute("call", params, undefined, {}, new AbortController().signal);
						emit({ type: "tool_execution_end", toolCallId: "call", toolName: name, result, isError: false });
						return result;
					} catch (error) {
						emit({ type: "tool_execution_end", toolCallId: "call", toolName: name, result: error, isError: true });
						throw error;
					}
				},
			};
			sessions.push(state);
			let abortPrompt: (() => void) | undefined;
			const session = {
				get model() {
					return state.model;
				},
				get messages() {
					return state.messages;
				},
				getEnabledToolNames: () => [...state.toolNames],
				getLastAssistantText: () => state.lastText,
				subscribe: (listener: FakeListener) => {
					state.listeners.push(listener);
					return () => {
						state.listeners = state.listeners.filter(l => l !== listener);
					};
				},
				prompt: async (text: string) => {
					state.prompts.push(text);
					for (const watcher of promptWatchers.splice(0)) watcher();
					const { promise, resolve } = Promise.withResolvers<void>();
					abortPrompt = resolve;
					await Promise.race([behavior(state, text), promise]);
					return true;
				},
				waitForIdle: async () => {},
				abort: async () => {
					state.aborted = true;
					abortPrompt?.();
				},
				dispose: async () => {
					state.disposed = true;
				},
			};
			return { session };
		},
	} as unknown as Sdk;
	return { sdk, sessions, options, waitForPrompts };
}

export async function tempStore(): Promise<CtfStore> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "omp-ctf-test-"));
	return new CtfStore(dir);
}
