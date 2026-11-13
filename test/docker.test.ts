import { describe, expect, test } from "bun:test";
import { MAX_DOWNLOAD_BYTES } from "../src/validate.ts";
import { FakeDockerCli, ok } from "./fakes.ts";

describe("docker health", () => {
	test("missing CLI: instructs the user and runs nothing", async () => {
		const cli = new FakeDockerCli();
		cli.hasCli = false;
		const health = await cli.docker.health();
		expect(health.ok).toBe(false);
		expect(health.ok ? "" : health.message).toMatch(/scripts\/setup\.sh/);
		expect(cli.calls).toHaveLength(0);
	});

	test("daemon down: reports and creates nothing", async () => {
		const cli = new FakeDockerCli();
		cli.respond = argv => (argv[1] === "info" ? { ...ok(), code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined);
		const health = await cli.docker.health();
		expect(health.ok ? "" : health.reason).toBe("daemon");
		expect(cli.calls.map(c => c.argv[1])).toEqual(["info"]);
	});
});

describe("containers", () => {
	test("browser publishes noVNC only on loopback, no CDP, hardened, own profile volume", async () => {
		const cli = new FakeDockerCli();
		const { noVncPort } = await cli.docker.startBrowser("evt-abc123", "tok", undefined);
		expect(noVncPort).toBe(49999);
		const run = cli.calls.find(c => c.argv[1] === "run")!.argv;
		expect(run).toContain("127.0.0.1::6080");
		expect(run.filter(a => a === "-p")).toHaveLength(1);
		for (const flag of ["--init", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512"]) expect(run).toContain(flag);
		expect(run.join(" ")).not.toMatch(/privileged|--network=host|--pid=host|docker\.sock|--device|9222/);
		expect(run).toContain("omp-ctf-evt-abc123-profile:/home/ctf/profile");
	});

	test("non-loopback binding fails closed: partial container removed, profile volume kept", async () => {
		const cli = new FakeDockerCli();
		cli.respond = argv => (argv[1] === "port" ? ok("0.0.0.0:49999\n") : undefined);
		await expect(cli.docker.startBrowser("evt-abc123", "tok")).rejects.toThrow(/non-loopback/);
		expect(cli.containers.size).toBe(0);
		expect(cli.volumes.has("omp-ctf-evt-abc123-profile")).toBe(true);
	});

	test("challenge container mounts only its own volume at /work", async () => {
		const cli = new FakeDockerCli();
		await cli.docker.startChallenge("evt-abc123", "c-0000000a");
		const run = cli.calls.find(c => c.argv[1] === "run")!.argv;
		const mounts = run.filter((_, i) => run[i - 1] === "-v");
		expect(mounts).toEqual(["omp-ctf-evt-abc123-c-0000000a-work:/work"]);
		expect(run).not.toContain("-e");
	});

	test("exec rejects traversal cwd before invoking docker", async () => {
		const cli = new FakeDockerCli();
		await expect(cli.docker.exec("c", ["ls"], { cwd: "../x", timeoutSec: 5 })).rejects.toThrow(/traversal/);
		expect(cli.calls).toHaveLength(0);
	});

	test("download broker refuses unexpected source paths and enforces the size cap", async () => {
		const cli = new FakeDockerCli();
		await expect(cli.docker.copyDownload("b", "/home/ctf/profile/Cookies", "c")).rejects.toThrow(/unexpected download path/);
		await expect(cli.docker.copyDownload("b", "/home/ctf/downloads/../profile", "c")).rejects.toThrow();
		expect(cli.pipes).toHaveLength(0);
		cli.pipeResult = { fromCode: 0, toCode: 0, bytes: MAX_DOWNLOAD_BYTES + 1, stderr: "", exceeded: true };
		await expect(cli.docker.copyDownload("b", "/home/ctf/downloads/a.bin", "c")).rejects.toThrow(/exceeds/);
		expect(cli.pipes[0]?.to).toEqual(["docker", "cp", "-", "c:/work/downloads"]);
	});
});
