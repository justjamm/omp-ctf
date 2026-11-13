/** Owner-only settings and minimal event manifests under ~/.omp/ctf. */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { assertChallengeId, assertEventId, randomHex } from "./validate.ts";

export const CONFIG_VERSION = 1;
export const MIN_WORKERS = 1;
export const MAX_WORKERS = 8;

export interface CtfConfig {
	version: 1;
	/** Standard worker model selectors (`provider/id`). Empty until first setup. */
	workerModels: string[];
	autoSubmit: boolean;
	maxWorkers: number;
}

export const DEFAULT_CONFIG: Readonly<CtfConfig> = Object.freeze({
	version: 1,
	workerModels: [],
	autoSubmit: false,
	maxWorkers: 4,
});

export class ConfigError extends Error {
	override name = "ConfigError";
}

export type ChallengeStatus = "queued" | "running" | "solved" | "submitted" | "refused" | "failed" | "cancelled" | "done";

export interface ChallengeManifest {
	id: string;
	name: string;
	status: ChallengeStatus;
	volume: string;
	createdAt: string;
}

export interface EventManifest {
	version: 1;
	eventId: string;
	name: string;
	url: string;
	createdAt: string;
	challenges: ChallengeManifest[];
}

export function defaultRoot(): string {
	return path.join(homedir(), ".omp", "ctf");
}

async function ensureOwnerDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(dir, 0o700);
}

async function writeOwnerFile(file: string, data: string): Promise<void> {
	await ensureOwnerDir(path.dirname(file));
	const tmp = `${file}.${randomHex(4)}.tmp`;
	await fs.writeFile(tmp, data, { mode: 0o600 });
	await fs.rename(tmp, file);
}

export function validateConfig(value: unknown): CtfConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("config must be a JSON object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== CONFIG_VERSION) throw new ConfigError(`unsupported config version ${JSON.stringify(raw.version)}; expected ${CONFIG_VERSION}`);
	const { workerModels, autoSubmit, maxWorkers } = raw;
	if (!Array.isArray(workerModels) || !workerModels.every(m => typeof m === "string" && /^[^/\s]+\/\S+$/.test(m))) {
		throw new ConfigError("workerModels must be an array of provider/model selectors");
	}
	if (new Set(workerModels).size !== workerModels.length) throw new ConfigError("workerModels contains duplicates");
	if (typeof autoSubmit !== "boolean") throw new ConfigError("autoSubmit must be a boolean");
	if (typeof maxWorkers !== "number" || !Number.isInteger(maxWorkers) || maxWorkers < MIN_WORKERS || maxWorkers > MAX_WORKERS) {
		throw new ConfigError(`maxWorkers must be an integer from ${MIN_WORKERS} to ${MAX_WORKERS}`);
	}
	const unknown = Object.keys(raw).filter(key => !["version", "workerModels", "autoSubmit", "maxWorkers"].includes(key));
	if (unknown.length > 0) throw new ConfigError(`unknown config fields: ${unknown.join(", ")}`);
	return { version: 1, workerModels: [...workerModels] as string[], autoSubmit, maxWorkers };
}

export class CtfStore {
	readonly root: string;
	constructor(root: string = defaultRoot()) {
		this.root = root;
	}

	get configPath(): string {
		return path.join(this.root, "config.json");
	}

	get eventsDir(): string {
		return path.join(this.root, "events");
	}

	/** Private empty directory used as the cwd of isolated SDK sessions. */
	async emptyCwd(): Promise<string> {
		const dir = path.join(this.root, "empty");
		await ensureOwnerDir(dir);
		return dir;
	}

	/** Returns `undefined` when no config exists. Malformed config throws until `/ctf reset-config`. */
	async loadConfig(): Promise<CtfConfig | undefined> {
		let text: string;
		try {
			text = await fs.readFile(this.configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new ConfigError(`${this.configPath} is not valid JSON (${(error as Error).message}). Run /ctf reset-config to replace it.`);
		}
		try {
			return validateConfig(parsed);
		} catch (error) {
			throw new ConfigError(`${this.configPath}: ${(error as Error).message}. Run /ctf reset-config to replace it.`);
		}
	}

	async loadConfigOrDefault(): Promise<CtfConfig> {
		return (await this.loadConfig()) ?? { ...DEFAULT_CONFIG, workerModels: [] };
	}

	async saveConfig(config: CtfConfig): Promise<void> {
		const valid = validateConfig(config);
		await writeOwnerFile(this.configPath, `${JSON.stringify(valid, null, 2)}\n`);
	}

	async resetConfig(): Promise<CtfConfig> {
		const fresh: CtfConfig = { ...DEFAULT_CONFIG, workerModels: [] };
		await writeOwnerFile(this.configPath, `${JSON.stringify(fresh, null, 2)}\n`);
		return fresh;
	}

	eventPath(eventId: string): string {
		return path.join(this.eventsDir, `${assertEventId(eventId)}.json`);
	}

	async saveEvent(manifest: EventManifest): Promise<void> {
		assertEventId(manifest.eventId);
		for (const challenge of manifest.challenges) assertChallengeId(challenge.id);
		await writeOwnerFile(this.eventPath(manifest.eventId), `${JSON.stringify(manifest, null, 2)}\n`);
	}

	async loadEvent(eventId: string): Promise<EventManifest | undefined> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.eventPath(eventId), "utf8")) as EventManifest;
			return parsed.version === 1 && parsed.eventId === eventId ? parsed : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async listEvents(): Promise<EventManifest[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.eventsDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const events: EventManifest[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const id = entry.slice(0, -5);
			try {
				const manifest = await this.loadEvent(id);
				if (manifest) events.push(manifest);
			} catch {
				// Skip unreadable manifests; history only lists what it can validate.
			}
		}
		return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async deleteEvent(eventId: string): Promise<void> {
		await fs.rm(this.eventPath(eventId), { force: true });
	}
}
