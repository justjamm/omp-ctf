/**
 * Build the omp-ctf images with the same tags and contexts /ctf uses. Invoked by scripts/setup.sh.
 * Exit codes: 0 ok, 1 failure, 3 the Docker daemon could not resolve a registry host.
 */
import { BROWSER_IMAGE, CHALLENGE_IMAGE, Docker, DockerError, dockerContextDir, unresolvedRegistry } from "../src/docker.ts";

const EXIT_DNS = 3;

const docker = new Docker();
const health = await docker.health();
if (!health.ok) {
	console.error(health.message);
	process.exit(1);
}
for (const [tag, context] of [
	[BROWSER_IMAGE, dockerContextDir("browser")],
	[CHALLENGE_IMAGE, dockerContextDir("challenge")],
] as const) {
	try {
		await docker.ensureImage(tag, context, undefined, line => console.log(line));
	} catch (error) {
		if (!(error instanceof DockerError)) throw error;
		console.error(error.message);
		const log = `${error.result?.stdout ?? ""}\n${error.result?.stderr ?? ""}`;
		const registry = unresolvedRegistry(log);
		if (registry) console.error(`unresolved-registry: ${registry}`);
		process.exit(registry ? EXIT_DNS : 1);
	}
	console.log(`ready: ${tag}`);
}
