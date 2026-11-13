/** Build the omp-ctf images with the same tags and contexts /ctf uses. Invoked by scripts/setup.sh. */
import { BROWSER_IMAGE, CHALLENGE_IMAGE, Docker, dockerContextDir } from "../src/docker.ts";

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
	await docker.ensureImage(tag, context, undefined, line => console.log(line));
	console.log(`ready: ${tag}`);
}
