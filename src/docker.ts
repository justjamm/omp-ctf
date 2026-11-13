/**
 * Docker CLI boundary. Every invocation is an argv array passed to Bun.spawn (never a shell);
 * exit status and stderr are captured, abort signals kill the client process, and every
 * resource this plugin creates carries `omp-ctf.*` labels so cleanup is event-scoped.
 */
import { fileURLToPath } from "node:url";
import { assertChallengeId, assertEventId, assertWorkspaceRelative, MAX_DOWNLOAD_BYTES, MAX_TEXT_BYTES, randomHex } from "./validate.ts";

export const PLAYWRIGHT_VERSION = "1.65.0";
export const BROWSER_IMAGE = `omp-ctf-browser:pw${PLAYWRIGHT_VERSION}-1`;
export const CHALLENGE_IMAGE = "omp-ctf-challenge:1";
export const NOVNC_CONTAINER_PORT = 6080;
export const CONTAINER_UID = "10001:10001";
export const LABEL_EVENT = "omp-ctf.event";
export const LABEL_ROLE = "omp-ctf.role";
export const LABEL_CHALLENGE = "omp-ctf.challenge";

export interface RunOptions {
	signal?: AbortSignal;
	stdin?: string | Uint8Array;
	timeoutMs?: number;
	/** Per-stream capture cap; excess is drained and discarded. */
	maxOutputBytes?: number;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	aborted: boolean;
}

export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>;
export type PipeRunner = (
	from: readonly string[],
	to: readonly string[],
	options: { signal?: AbortSignal; maxBytes: number },
) => Promise<{ fromCode: number; toCode: number; bytes: number; stderr: string; exceeded: boolean }>;

export class DockerError extends Error {
	override name = "DockerError";
	constructor(
		message: string,
		readonly result?: RunResult,
	) {
		super(message);
	}
}

async function drain(stream: ReadableStream<Uint8Array> | null | undefined, cap: number): Promise<{ text: string; truncated: boolean }> {
	if (!stream) return { text: "", truncated: false };
	const chunks: Uint8Array[] = [];
	let kept = 0;
	let truncated = false;
	for await (const chunk of stream) {
		if (kept < cap) {
			const take = chunk.subarray(0, cap - kept);
			chunks.push(take);
			kept += take.byteLength;
			if (take.byteLength < chunk.byteLength) truncated = true;
		} else {
			truncated = true;
		}
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Minimal environment for the Docker CLI: enough to find the binary and its context/config,
 * without forwarding unrelated host credentials. Unset keys are omitted, never blanked.
 */
function dockerClientEnv(): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
	for (const key of ["HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** Production runner backed by Bun.spawn argument arrays. */
export const bunRunner: Runner = async (argv, options = {}) => {
	const { signal, stdin, timeoutMs, maxOutputBytes = MAX_TEXT_BYTES } = options;
	if (signal?.aborted) return { code: -1, stdout: "", stderr: "aborted before start", truncated: false, timedOut: false, aborted: true };
	const proc = Bun.spawn([...argv], {
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: dockerClientEnv(),
	});
	let aborted = false;
	let timedOut = false;
	const onAbort = () => {
		aborted = true;
		proc.kill("SIGKILL");
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = timeoutMs
		? setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
			}, timeoutMs)
		: undefined;
	try {
		if (stdin !== undefined && proc.stdin) {
			proc.stdin.write(stdin);
			await proc.stdin.end();
		}
		const [out, err, code] = await Promise.all([drain(proc.stdout, maxOutputBytes), drain(proc.stderr, maxOutputBytes), proc.exited]);
		return { code, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
};

/** Production pipe: `from` stdout streams into `to` stdin with a hard byte cap. */
export const bunPipeRunner: PipeRunner = async (from, to, { signal, maxBytes }) => {
	const env = dockerClientEnv();
	const src = Bun.spawn([...from], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
	const dst = Bun.spawn([...to], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
	const killAll = () => {
		src.kill("SIGKILL");
		dst.kill("SIGKILL");
	};
	signal?.addEventListener("abort", killAll, { once: true });
	let bytes = 0;
	let exceeded = false;
	try {
		const pump = (async () => {
			for await (const chunk of src.stdout) {
				bytes += chunk.byteLength;
				if (bytes > maxBytes) {
					exceeded = true;
					killAll();
					break;
				}
				dst.stdin.write(chunk);
			}
			await dst.stdin.end();
		})();
		const [srcErr, dstErr] = await Promise.all([drain(src.stderr, 64 * 1024), drain(dst.stderr, 64 * 1024), drain(dst.stdout, 64 * 1024), pump]);
		const [fromCode, toCode] = await Promise.all([src.exited, dst.exited]);
		return { fromCode, toCode, bytes, exceeded, stderr: `${srcErr.text}${dstErr.text}`.trim() };
	} finally {
		signal?.removeEventListener("abort", killAll);
	}
};

export type DockerHealth = { ok: true; serverVersion: string } | { ok: false; reason: "missing-cli" | "daemon"; message: string };

export function dockerContextDir(name: "browser" | "challenge"): string {
	return fileURLToPath(new URL(`../docker/${name}`, import.meta.url));
}

/** One-time installer shipped with the plugin; /ctf itself never installs software. */
export const SETUP_SCRIPT = fileURLToPath(new URL("../scripts/setup.sh", import.meta.url));

/** Actionable message for a docker CLI that cannot reach its daemon. No resources were created. */
function daemonHint(stderr: string): string {
	const detail = stderr || "no server version";
	const fix = /permission denied/i.test(stderr)
		? "Your user cannot access the Docker socket yet: log out and back in (docker group) or run 'newgrp docker', then restart omp."
		: process.platform === "darwin"
			? "Start it with 'colima start' (or re-run the setup script)."
			: "Start it with 'sudo systemctl start docker' (or re-run the setup script).";
	return `The Docker daemon is unavailable: ${detail}. ${fix} Setup script: ${SETUP_SCRIPT}. No resources were created.`;
}

export function browserContainerName(eventId: string): string {
	return `omp-ctf-${assertEventId(eventId)}-browser`;
}
export function profileVolumeName(eventId: string): string {
	return `omp-ctf-${assertEventId(eventId)}-profile`;
}
export function challengeContainerName(eventId: string, challengeId: string): string {
	return `omp-ctf-${assertEventId(eventId)}-${assertChallengeId(challengeId)}`;
}
export function challengeVolumeName(eventId: string, challengeId: string): string {
	return `omp-ctf-${assertEventId(eventId)}-${assertChallengeId(challengeId)}-work`;
}

/** Hardening flags shared by every container this plugin starts. */
export function hardeningArgs(): string[] {
	return [
		"--init",
		"--user",
		CONTAINER_UID,
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--cpus=2",
		"--memory=2g",
		"--memory-swap=2g",
		"--pids-limit=512",
	];
}

export interface ExecOptions {
	cwd?: string;
	stdin?: string;
	timeoutSec: number;
	signal?: AbortSignal;
	maxOutputBytes?: number;
}

export class Docker {
	constructor(
		private readonly run: Runner = bunRunner,
		private readonly pipe: PipeRunner = bunPipeRunner,
		private readonly which: (cmd: string) => string | null = cmd => Bun.which(cmd),
	) {}

	private async docker(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
		return this.run(["docker", ...args], options);
	}

	private async must(args: readonly string[], options: RunOptions = {}, what = args[0] ?? "docker"): Promise<RunResult> {
		const result = await this.docker(args, options);
		if (result.aborted) throw new DockerError(`docker ${what} aborted`, result);
		if (result.code !== 0) throw new DockerError(`docker ${what} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`, result);
		return result;
	}

	/** CLI presence first, then daemon reachability. Never installs anything. */
	async health(signal?: AbortSignal): Promise<DockerHealth> {
		if (!this.which("docker")) {
			return {
				ok: false,
				reason: "missing-cli",
				message: `The docker CLI was not found on PATH. In a terminal (outside OMP), run ${SETUP_SCRIPT} to install Docker and the other dependencies, then retry /ctf.`,
			};
		}
		const result = await this.docker(["info", "--format", "{{.ServerVersion}}"], { signal, timeoutMs: 20_000 });
		if (result.code !== 0 || !result.stdout.trim()) {
			return {
				ok: false,
				reason: "daemon",
				message: daemonHint(result.stderr.trim()),
			};
		}
		return { ok: true, serverVersion: result.stdout.trim() };
	}

	async imageExists(tag: string, signal?: AbortSignal): Promise<boolean> {
		const result = await this.docker(["image", "inspect", "--format", "{{.Id}}", tag], { signal });
		return result.code === 0;
	}

	async ensureImage(tag: string, contextDir: string, signal?: AbortSignal, onProgress?: (line: string) => void): Promise<void> {
		if (await this.imageExists(tag, signal)) return;
		onProgress?.(`Building ${tag} (first run only)…`);
		await this.must(["build", "--pull", "--label", "omp-ctf.image=1", "-t", tag, contextDir], { signal, timeoutMs: 30 * 60_000, maxOutputBytes: 256 * 1024 }, "build");
	}

	async ensureVolume(name: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void> {
		const exists = await this.docker(["volume", "inspect", "--format", "{{.Name}}", name], { signal });
		if (exists.code === 0) return;
		const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
		await this.must(["volume", "create", ...labelArgs, name], { signal }, "volume create");
	}

	async removeVolume(name: string, signal?: AbortSignal): Promise<void> {
		const result = await this.docker(["volume", "rm", "-f", name], { signal });
		if (result.code !== 0 && !/no such volume/i.test(result.stderr)) throw new DockerError(`docker volume rm failed: ${result.stderr.trim()}`, result);
	}

	async listVolumes(eventId: string, signal?: AbortSignal): Promise<string[]> {
		const result = await this.must(["volume", "ls", "-q", "--filter", `label=${LABEL_EVENT}=${assertEventId(eventId)}`], { signal }, "volume ls");
		return result.stdout.split("\n").map(s => s.trim()).filter(Boolean);
	}

	async listContainers(eventId: string, signal?: AbortSignal): Promise<string[]> {
		const result = await this.must(["ps", "-a", "-q", "--filter", `label=${LABEL_EVENT}=${assertEventId(eventId)}`], { signal }, "ps");
		return result.stdout.split("\n").map(s => s.trim()).filter(Boolean);
	}

	async removeContainer(nameOrId: string, signal?: AbortSignal): Promise<void> {
		const result = await this.docker(["rm", "-f", "-v", nameOrId], { signal });
		if (result.code !== 0 && !/no such container/i.test(result.stderr)) throw new DockerError(`docker rm failed: ${result.stderr.trim()}`, result);
	}

	async isRunning(name: string, signal?: AbortSignal): Promise<boolean> {
		const result = await this.docker(["inspect", "--format", "{{.State.Running}}", name], { signal });
		return result.code === 0 && result.stdout.trim() === "true";
	}

	/**
	 * Start the headed browser container. Its profile lives in its own named volume; noVNC is
	 * published only on a random loopback port and guarded by `token`; no CDP port is exposed.
	 * On failure the partial container is removed while the profile volume is preserved.
	 */
	async startBrowser(eventId: string, token: string, signal?: AbortSignal): Promise<{ container: string; noVncPort: number }> {
		const container = browserContainerName(eventId);
		const profile = profileVolumeName(eventId);
		await this.ensureVolume(profile, { [LABEL_EVENT]: eventId, [LABEL_ROLE]: "profile" }, signal);
		await this.removeContainer(container, signal);
		try {
			await this.must(
				[
					"run",
					"-d",
					"--name",
					container,
					...hardeningArgs(),
					"--shm-size=1g",
					"--label",
					`${LABEL_EVENT}=${eventId}`,
					"--label",
					`${LABEL_ROLE}=browser`,
					"-p",
					`127.0.0.1::${NOVNC_CONTAINER_PORT}`,
					"-v",
					`${profile}:/home/ctf/profile`,
					"-e",
					`NOVNC_TOKEN=${token}`,
					BROWSER_IMAGE,
				],
				{ signal, timeoutMs: 120_000 },
				"run (browser)",
			);
			const noVncPort = await this.loopbackPort(container, NOVNC_CONTAINER_PORT, signal);
			return { container, noVncPort };
		} catch (error) {
			await this.removeContainer(container).catch(() => {});
			throw error;
		}
	}

	/** Resolve a published port and fail closed unless every binding is on 127.0.0.1. */
	async loopbackPort(container: string, containerPort: number, signal?: AbortSignal): Promise<number> {
		const result = await this.must(["port", container, `${containerPort}/tcp`], { signal }, "port");
		const bindings = result.stdout.split("\n").map(s => s.trim()).filter(Boolean);
		if (bindings.length === 0) throw new DockerError(`No published port for ${container}:${containerPort}`);
		let port: number | undefined;
		for (const binding of bindings) {
			const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(binding);
			if (!match) throw new DockerError(`Refusing non-loopback port binding ${JSON.stringify(binding)} for ${container}`);
			port = Number(match[1]);
		}
		if (!port || port < 1 || port > 65_535) throw new DockerError(`Invalid published port for ${container}`);
		return port;
	}

	/** Start one challenge container mounting only its own named volume at /work. */
	async startChallenge(eventId: string, challengeId: string, signal?: AbortSignal): Promise<{ container: string; volume: string }> {
		const container = challengeContainerName(eventId, challengeId);
		const volume = challengeVolumeName(eventId, challengeId);
		await this.ensureVolume(volume, { [LABEL_EVENT]: eventId, [LABEL_ROLE]: "challenge", [LABEL_CHALLENGE]: challengeId }, signal);
		try {
			await this.must(
				[
					"run",
					"-d",
					"--name",
					container,
					...hardeningArgs(),
					"--label",
					`${LABEL_EVENT}=${eventId}`,
					"--label",
					`${LABEL_ROLE}=challenge`,
					"--label",
					`${LABEL_CHALLENGE}=${challengeId}`,
					"-v",
					`${volume}:/work`,
					"-w",
					"/work",
					CHALLENGE_IMAGE,
				],
				{ signal, timeoutMs: 120_000 },
				"run (challenge)",
			);
			return { container, volume };
		} catch (error) {
			await this.removeContainer(container).catch(() => {});
			throw error;
		}
	}

	/**
	 * Run argv inside a challenge container as the unprivileged user, bounded by an in-container
	 * `timeout`. Abort kills the client and signals the in-container process tree by marker.
	 */
	async exec(container: string, argv: readonly string[], options: ExecOptions): Promise<RunResult> {
		const marker = `CTF_EXEC=${randomHex(8)}`;
		const cwd = options.cwd === undefined ? "" : assertWorkspaceRelative(options.cwd);
		const args = [
			"exec",
			...(options.stdin !== undefined ? ["-i"] : []),
			"--user",
			CONTAINER_UID,
			"-w",
			cwd ? `/work/${cwd}` : "/work",
			container,
			"timeout",
			"-k",
			"5",
			String(options.timeoutSec),
			"env",
			marker,
			...argv,
		];
		const result = await this.docker(args, {
			signal: options.signal,
			stdin: options.stdin,
			timeoutMs: (options.timeoutSec + 15) * 1000,
			maxOutputBytes: options.maxOutputBytes ?? MAX_TEXT_BYTES,
		});
		if (result.aborted || result.timedOut) {
			await this.docker(["exec", "--user", CONTAINER_UID, container, "pkill", "-TERM", "-f", marker], { timeoutMs: 10_000 }).catch(() => {});
		}
		return result;
	}

	/** Invoke the fixed browser driver inside the browser container with a JSON request on stdin. */
	async browserCall(container: string, request: unknown, options: { signal?: AbortSignal; timeoutMs: number }): Promise<RunResult> {
		return this.docker(["exec", "-i", "--user", CONTAINER_UID, container, "node", "/opt/ctf-driver/driver.mjs", "call"], {
			signal: options.signal,
			stdin: JSON.stringify(request),
			timeoutMs: options.timeoutMs + 15_000,
			maxOutputBytes: MAX_TEXT_BYTES + 64 * 1024,
		});
	}

	/**
	 * Copy one file from the browser container into exactly one challenge volume's /work/downloads.
	 * `docker cp` emits/consumes a tar stream, so the destination is fixed and the name is the basename.
	 */
	async copyDownload(
		browserContainer: string,
		sourcePath: string,
		challengeContainer: string,
		signal?: AbortSignal,
	): Promise<{ bytes: number }> {
		if (!/^\/home\/ctf\/downloads\/[A-Za-z0-9._-]{1,200}$/.test(sourcePath) || sourcePath.includes("/..")) {
			throw new DockerError(`Refusing to copy unexpected download path ${JSON.stringify(sourcePath)}`);
		}
		await this.must(["exec", "--user", CONTAINER_UID, challengeContainer, "mkdir", "-p", "/work/downloads"], { signal }, "exec mkdir");
		const result = await this.pipe(
			["docker", "cp", `${browserContainer}:${sourcePath}`, "-"],
			["docker", "cp", "-", `${challengeContainer}:/work/downloads`],
			{ signal, maxBytes: MAX_DOWNLOAD_BYTES + 64 * 1024 },
		);
		if (result.exceeded) throw new DockerError(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
		if (result.fromCode !== 0 || result.toCode !== 0) throw new DockerError(`Download copy failed: ${result.stderr}`);
		return { bytes: result.bytes };
	}

	/** List up to 500 entries of a stored challenge volume via a throwaway, network-less, read-only helper. */
	async listVolumeFiles(volume: string, signal?: AbortSignal): Promise<string[]> {
		const result = await this.must(
			["run", "--rm", ...hardeningArgs(), "--network=none", "--read-only", "-v", `${volume}:/src:ro`, "-w", "/src", CHALLENGE_IMAGE, "find", ".", "-maxdepth", "4", "-mindepth", "1"],
			{ signal, timeoutMs: 60_000 },
			"run (list)",
		);
		return result.stdout
			.split("\n")
			.map(s => s.trim().replace(/^\.\//, ""))
			.filter(Boolean)
			.slice(0, 500);
	}

	/** Copy one approved path from a stored volume into the target volume's /work/imported/<source>/. */
	async importArtifact(sourceVolume: string, relPath: string, targetVolume: string, sourceChallengeId: string, signal?: AbortSignal): Promise<void> {
		const rel = assertWorkspaceRelative(relPath);
		if (!rel) throw new DockerError("Refusing to import an entire workspace; select a specific artifact");
		assertChallengeId(sourceChallengeId);
		const dest = `/dst/imported/${sourceChallengeId}`;
		await this.must(
			[
				"run",
				"--rm",
				...hardeningArgs(),
				"--network=none",
				"-v",
				`${sourceVolume}:/src:ro`,
				"-v",
				`${targetVolume}:/dst`,
				"-w",
				"/src",
				CHALLENGE_IMAGE,
				"sh",
				"-c",
				'mkdir -p "$1" && cp -a --parents -- "$2" "$1"',
				"import",
				dest,
				rel,
			],
			{ signal, timeoutMs: 300_000 },
			"run (import)",
		);
	}
}
