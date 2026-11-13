/** `/ctf` subcommands. Owns the single active run per extension process. */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext, ExtensionUIContext, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { type CtfConfig, CtfStore, MAX_WORKERS, MIN_WORKERS } from "./config.ts";
import { challengeVolumeName, Docker } from "./docker.ts";
import { CtfRun, type Model, modelSelector, NETWORK_WARNING, type Sdk } from "./runtime.ts";
import { callBrowser, type Zod } from "./tools.ts";
import { assertEventId, assertHttpUrl, newEventId, ValidationError } from "./validate.ts";

export interface ControllerDeps {
	sdk: Sdk;
	z: Zod;
	docker?: Docker;
	store?: CtfStore;
	/** Opens a URL in the operator's browser; resolves false when it could not. */
	openUrl?: (url: string) => Promise<boolean>;
}

export const USAGE = [
	"/ctf [event]              — pick head model, open the contained Chromium, sign in yourself, run",
	"/ctf start [event]        — same as /ctf",
	"/ctf status               — show the active run",
	"/ctf stop                 — abort workers, remove containers (volumes kept)",
	"/ctf settings             — worker models, concurrency, auto-submit",
	"/ctf settings auto-submit on|off",
	"/ctf history              — list prior events; optionally import one approved artifact",
	"/ctf purge <event-id>     — delete one event's volumes and metadata",
	"/ctf reset-config         — replace config with defaults",
].join("\n");

const DONE = "✓ Done";

async function defaultOpenUrl(url: string): Promise<boolean> {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? undefined : "xdg-open";
	if (!cmd || !Bun.which(cmd)) return false;
	try {
		const proc = Bun.spawn([cmd, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

function interactiveUi(ctx: ExtensionCommandContext): ExtensionUIContext | undefined {
	return ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;
}

export class CtfController {
	readonly docker: Docker;
	readonly store: CtfStore;
	#deps: ControllerDeps;
	#openUrl: (url: string) => Promise<boolean>;
	#run: CtfRun | undefined;
	#starting = false;

	constructor(deps: ControllerDeps) {
		this.#deps = deps;
		this.docker = deps.docker ?? new Docker();
		this.store = deps.store ?? new CtfStore();
		this.#openUrl = deps.openUrl ?? defaultOpenUrl;
	}

	get activeRun(): CtfRun | undefined {
		return this.#run;
	}

	async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		try {
			switch (sub) {
				case "":
				case "start":
					return await this.start(rest, ctx);
				case "status":
					return this.status(ctx);
				case "stop":
					return await this.stop(ctx);
				case "settings":
					return await this.settings(rest, ctx);
				case "history":
					return await this.history(ctx);
				case "purge":
					return await this.purge(rest, ctx);
				case "reset-config":
					return await this.resetConfig(ctx);
				case "help":
					ctx.ui.notify(`Usage:\n${USAGE}`, "info");
					return;
				default:
					ctx.ui.notify(`Unknown subcommand ${JSON.stringify(sub)}. Usage:\n${USAGE}`, "warning");
			}
		} catch (error) {
			ctx.ui.notify(`/ctf ${sub}: ${(error as Error).message}`, "error");
		}
	}

	/** Abort and stop containers without purging data (session shutdown). */
	async shutdown(): Promise<void> {
		const run = this.#run;
		this.#run = undefined;
		await run?.stop();
	}

	async start(rest: string[], ctx: ExtensionCommandContext): Promise<void> {
		if (this.#run || this.#starting) {
			const run = this.#run;
			ctx.ui.notify(run ? `A CTF run is already active: ${run.eventName} [${run.eventId}] (${run.phase}). Run /ctf stop first.` : "A CTF run is starting. Run /ctf stop first.", "warning");
			return;
		}
		const ui = interactiveUi(ctx);
		if (!ui) throw new Error("/ctf requires the interactive TUI (model selection, sign-in and confirmations).");
		const eventArg = rest.join(" ").trim();
		this.#starting = true;
		let run: CtfRun | undefined;
		try {
			// 1. Fresh head selection every start; never preselected or persisted.
			const available = ctx.modelRegistry.getAvailable();
			const head = await pickModel(ui, "Select the HEAD model for this CTF run (your abliterated coordinator model)", available, []);
			if (!head) {
				ui.notify("Head model selection dismissed; /ctf start aborted.", "warning");
				return;
			}
			// 2. Config (malformed config throws until /ctf reset-config) and worker models.
			let config = await this.store.loadConfigOrDefault();
			if (config.workerModels.length === 0) {
				const workers = await pickWorkers(ui, available, [modelSelector(head)]);
				if (!workers) {
					ui.notify("Worker model selection dismissed; /ctf start aborted.", "warning");
					return;
				}
				config = { ...config, workerModels: workers.map(modelSelector) };
				await this.store.saveConfig(config);
			}
			const workerModels = resolveWorkers(ctx.modelRegistry, config.workerModels);
			if (config.workerModels.includes(modelSelector(head))) {
				throw new Error(`${modelSelector(head)} is configured as a worker. The head must be separate; pick another head or change workers in /ctf settings.`);
			}
			// 3. Event. The website URL is not needed up front: the operator navigates and signs in themselves.
			const existing = eventArg && /^[a-z0-9][a-z0-9-]{0,62}$/.test(eventArg) ? await this.store.loadEvent(eventArg) : undefined;
			const eventId = existing?.eventId ?? newEventId(eventArg || "ctf");
			const eventName = existing?.name ?? (eventArg || "CTF");
			// 4. Docker before creating anything.
			const health = await this.docker.health();
			if (!health.ok) {
				ui.notify(health.message, "error");
				return;
			}
			ui.notify(NETWORK_WARNING, "warning");
			run = new CtfRun(
				{
					sdk: this.#deps.sdk,
					z: this.#deps.z,
					docker: this.docker,
					store: this.store,
					modelRegistry: ctx.modelRegistry,
					ui,
					hostPaths: [homedir(), ctx.cwd, fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""), this.store.root],
					sessionCwd: await this.store.emptyCwd(),
					onStatus: lines => {
						ui.setWidget("ctf", lines);
						ui.setStatus("ctf", lines[0]);
					},
				},
				{ eventId, eventName, headModel: head, workerModels, config },
			);
			this.#run = run;
			await run.startInfrastructure(line => ui.notify(line, "info"));
			// 5. Manual sign-in: open the contained, headed Chromium (via loopback noVNC) and ask.
			const opened = await this.#openUrl(run.noVncUrl);
			ui.notify(
				opened
					? "Opened the contained Chromium browser. Navigate to the challenge website there and sign in, then answer the question here."
					: `Open this loopback URL to reach the contained Chromium browser, navigate to the challenge website and sign in, then answer the question here:\n${run.noVncUrl}`,
				"info",
			);
			const signedIn = await askSignedIn(ui, run);
			if (!signedIn) {
				await this.#stopRun(run);
				ui.notify("CTF run cancelled; containers removed (browser profile kept). Run /ctf again when you are ready.", "info");
				return;
			}
			const started = run;
			void started.beginHead(signedIn.href, eventArg || existing ? undefined : signedIn.hostname).finally(() => {
				if (this.#run === started && !started.signal.aborted) ui.notify(`CTF run ${started.eventName}: ${started.phase}. /ctf status for details; /ctf stop to remove containers.`, "info");
			});
			ui.notify(`CTF run started for ${started.eventName} (${signedIn.href}) [${eventId}] with head ${modelSelector(head)}.`, "info");
		} catch (error) {
			if (run) await this.#stopRun(run).catch(() => {});
			throw error;
		} finally {
			this.#starting = false;
		}
	}

	async #stopRun(run: CtfRun): Promise<void> {
		if (this.#run === run) this.#run = undefined;
		await run.stop();
	}

	status(ctx: ExtensionCommandContext): void {
		const run = this.#run;
		if (!run) {
			ctx.ui.notify("No active CTF run.", "info");
			return;
		}
		ctx.ui.notify(run.statusLines().join("\n"), "info");
	}

	async stop(ctx: ExtensionCommandContext): Promise<void> {
		const run = this.#run;
		if (!run) {
			ctx.ui.notify("No active CTF run.", "info");
			return;
		}
		await this.#stopRun(run);
		ctx.ui.setWidget("ctf", undefined);
		ctx.ui.setStatus("ctf", undefined);
		ctx.ui.notify(`Stopped ${run.eventName} [${run.eventId}]: workers aborted and containers removed. Volumes and browser profile kept (/ctf purge ${run.eventId} deletes them).`, "info");
	}

	async settings(rest: string[], ctx: ExtensionCommandContext): Promise<void> {
		if (rest[0] === "auto-submit") {
			const value = rest[1];
			if (value !== "on" && value !== "off") throw new ValidationError("Usage: /ctf settings auto-submit on|off");
			const config = await this.store.loadConfigOrDefault();
			await this.store.saveConfig({ ...config, autoSubmit: value === "on" });
			this.#run?.setAutoSubmit(value === "on");
			ctx.ui.notify(`Auto-submit ${value}.${value === "on" ? " Flags will be submitted without confirmation." : " Every flag submission requires your confirmation."}`, "info");
			return;
		}
		if (rest.length > 0) throw new ValidationError(`Unknown settings arguments.\n${USAGE}`);
		let config = await this.store.loadConfigOrDefault();
		const ui = interactiveUi(ctx);
		if (!ui) {
			ctx.ui.notify(describeConfig(config), "info");
			return;
		}
		for (;;) {
			const choice = await ui.select(describeConfig(config), ["Change worker models", "Change max workers", `Turn auto-submit ${config.autoSubmit ? "off" : "on"}`, DONE]);
			if (choice === undefined || choice === DONE) return;
			if (choice === "Change worker models") {
				const workers = await pickWorkers(ui, ctx.modelRegistry.getAvailable(), []);
				if (workers) config = { ...config, workerModels: workers.map(modelSelector) };
			} else if (choice === "Change max workers") {
				const raw = await ui.input(`Max concurrent workers (${MIN_WORKERS}-${MAX_WORKERS})`, String(config.maxWorkers));
				if (raw === undefined) continue;
				const value = Number(raw.trim());
				if (!Number.isInteger(value) || value < MIN_WORKERS || value > MAX_WORKERS) {
					ui.notify(`Max workers must be an integer from ${MIN_WORKERS} to ${MAX_WORKERS}.`, "error");
					continue;
				}
				config = { ...config, maxWorkers: value };
			} else {
				config = { ...config, autoSubmit: !config.autoSubmit };
				this.#run?.setAutoSubmit(config.autoSubmit);
			}
			await this.store.saveConfig(config);
			if (this.#run) ui.notify("Worker model and concurrency changes apply to the next /ctf start.", "info");
		}
	}

	async history(ctx: ExtensionCommandContext): Promise<void> {
		const events = await this.store.listEvents();
		if (events.length === 0) {
			ctx.ui.notify("No CTF history.", "info");
			return;
		}
		const ui = interactiveUi(ctx);
		const listing = events.map(e => `${e.eventId} — ${e.name} (${e.url}) — ${e.challenges.length} challenge(s), ${e.createdAt}`).join("\n");
		if (!ui) {
			ctx.ui.notify(`CTF history (operator only; never shared with models):\n${listing}`, "info");
			return;
		}
		const eventLabel = await ui.select("CTF history (shown to you only). Select an event:", events.map(e => `${e.eventId} — ${e.name}`));
		const event = events.find(e => `${e.eventId} — ${e.name}` === eventLabel);
		if (!event) return;
		if (event.challenges.length === 0) {
			ui.notify(`${event.eventId} has no stored challenges.`, "info");
			return;
		}
		const challengeLabel = await ui.select(`${event.name}: select a challenge`, event.challenges.map(c => `${c.id} — ${c.name} [${c.status}]`));
		const challenge = event.challenges.find(c => `${c.id} — ${c.name} [${c.status}]` === challengeLabel);
		if (!challenge) return;
		const run = this.#run;
		if (!run || (run.eventId === event.eventId && run.challengeIds().includes(challenge.id))) {
			ui.notify(`${challenge.id} (${challenge.name}) volume ${challenge.volume}. Importing artifacts requires an active run with a different challenge.`, "info");
			return;
		}
		const expectedVolume = challengeVolumeName(event.eventId, challenge.id);
		if (challenge.volume !== expectedVolume) throw new Error(`Manifest volume ${challenge.volume} does not match ${expectedVolume}; refusing to import.`);
		const targets = run.challengeIds().map(id => run.challenge(id)).filter(t => t !== undefined);
		if (targets.length === 0) {
			ui.notify("No running challenge in the current run to import into.", "info");
			return;
		}
		const targetLabel = await ui.select("Import into which current challenge?", targets.map(t => `${t.id} — ${t.name}`));
		const target = targets.find(t => `${t.id} — ${t.name}` === targetLabel);
		if (!target) return;
		const health = await this.docker.health();
		if (!health.ok) throw new Error(health.message);
		const files = await this.docker.listVolumeFiles(challenge.volume);
		if (files.length === 0) {
			ui.notify("That challenge volume is empty.", "info");
			return;
		}
		const artifact = await ui.select(`Select the exact artifact from ${challenge.id} to import:`, files);
		if (!artifact || !files.includes(artifact)) return;
		const approved = await ui.confirm(
			"Import artifact into current challenge?",
			`From: ${event.eventId} / ${challenge.id} (${challenge.name})\nArtifact: ${artifact}\nInto: ${target.id} (${target.name}) at /work/imported/${challenge.id}/${artifact}\nThe worker for ${target.id} will be able to read it.`,
		);
		if (!approved) {
			ui.notify("Not imported. Nothing from history was shared with any model.", "info");
			return;
		}
		await this.docker.importArtifact(challenge.volume, artifact, target.volume, challenge.id);
		ui.notify(`Imported ${artifact} into ${target.id} at /work/imported/${challenge.id}/.`, "info");
	}

	async purge(rest: string[], ctx: ExtensionCommandContext): Promise<void> {
		const eventId = assertEventId(rest[0] ?? "");
		if (this.#run?.eventId === eventId) throw new Error(`${eventId} is the active run; /ctf stop first.`);
		const ui = interactiveUi(ctx);
		if (!ui) throw new Error("/ctf purge requires TUI confirmation.");
		const health = await this.docker.health();
		if (!health.ok) throw new Error(health.message);
		const manifest = await this.store.loadEvent(eventId);
		const volumes = await this.docker.listVolumes(eventId);
		if (!manifest && volumes.length === 0) {
			ui.notify(`No data found for ${eventId}.`, "info");
			return;
		}
		const approved = await ui.confirm(
			`Purge ${eventId}?`,
			`Permanently delete ${manifest ? `"${manifest.name}" ` : ""}metadata and ${volumes.length} volume(s):\n${volumes.join("\n") || "(none)"}\nOther events are not affected.`,
		);
		if (!approved) {
			ui.notify("Purge cancelled.", "info");
			return;
		}
		for (const container of await this.docker.listContainers(eventId)) await this.docker.removeContainer(container);
		for (const volume of volumes) await this.docker.removeVolume(volume);
		await this.store.deleteEvent(eventId);
		ui.notify(`Purged ${eventId}.`, "info");
	}

	async resetConfig(ctx: ExtensionCommandContext): Promise<void> {
		const ui = interactiveUi(ctx);
		if (!ui) throw new Error("/ctf reset-config requires TUI confirmation.");
		if (!(await ui.confirm("Reset CTF config?", `Replace ${this.store.configPath} with defaults (no worker models, auto-submit off, 4 workers)?`))) return;
		await this.store.resetConfig();
		ui.notify("CTF config reset to defaults.", "info");
	}
}

export const SIGNED_IN_QUESTION = "Have you signed into the challenge website?";

/**
 * Ask until the operator confirms sign-in while the contained browser shows an http(s) page.
 * Returns that page's URL, or undefined when the operator answers No or dismisses the question.
 */
async function askSignedIn(ui: ExtensionUIContext, run: CtfRun): Promise<URL | undefined> {
	for (;;) {
		const answer = await ui.select(SIGNED_IN_QUESTION, ["Yes", "No"], { signal: run.signal });
		if (answer !== "Yes") return undefined;
		let page: Record<string, unknown>;
		try {
			page = await callBrowser(run, { op: "observe", pageId: "head", timeoutMs: 15_000 }, run.signal, 15_000);
		} catch (error) {
			ui.notify(`Could not read the contained browser (${(error as Error).message}). Make sure the challenge website is open there, then answer again.`, "warning");
			continue;
		}
		try {
			return assertHttpUrl(String(page.url));
		} catch {
			ui.notify("The contained Chromium is not showing an http(s) page. Navigate to the challenge website there and sign in, then answer again.", "warning");
		}
	}
}

function describeConfig(config: CtfConfig): string {
	return [
		"CTF settings (head model is chosen at every /ctf start and never saved)",
		`Worker models: ${config.workerModels.join(", ") || "(none — chosen at first start)"}`,
		`Max workers: ${config.maxWorkers}`,
		`Auto-submit: ${config.autoSubmit ? "on" : "off"}`,
	].join("\n");
}

async function pickModel(ui: ExtensionUIContext, title: string, models: Model[], exclude: string[]): Promise<Model | undefined> {
	const candidates = models.filter(model => !exclude.includes(modelSelector(model)));
	if (candidates.length === 0) throw new Error("No authenticated models are available. Log in to a provider first.");
	const choice = await ui.select(title, candidates.map(modelSelector));
	return candidates.find(model => modelSelector(model) === choice);
}

/** Repeated selection of one or more standard worker models. Undefined when dismissed with none. */
async function pickWorkers(ui: ExtensionUIContext, models: Model[], exclude: string[]): Promise<Model[] | undefined> {
	const chosen: Model[] = [];
	for (;;) {
		const remaining = models.filter(model => !exclude.includes(modelSelector(model)) && !chosen.includes(model));
		const options = [...remaining.map(modelSelector), ...(chosen.length > 0 ? [`${DONE} (${chosen.map(modelSelector).join(", ")})`] : [])];
		if (options.length === 0) break;
		const choice = await ui.select(chosen.length === 0 ? "Select a standard WORKER model (separate from the head)" : "Add another worker model, or finish", options);
		if (choice === undefined) return chosen.length > 0 ? chosen : undefined;
		if (choice.startsWith(DONE)) break;
		const model = remaining.find(m => modelSelector(m) === choice);
		if (model) chosen.push(model);
	}
	return chosen.length > 0 ? chosen : undefined;
}

/** Resolve saved worker selectors explicitly; unavailable or unauthenticated models fail (no fallback). */
export function resolveWorkers(registry: Pick<ModelRegistry, "getAvailable">, selectors: string[]): Model[] {
	const available = registry.getAvailable();
	return selectors.map(selector => {
		const model = available.find(m => modelSelector(m) === selector);
		if (!model) throw new Error(`Worker model ${selector} is unavailable or unauthenticated. Fix its login or change workers in /ctf settings; no fallback model is used.`);
		return model;
	});
}
