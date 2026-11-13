import { describe, expect, test } from "bun:test";
import type { ExtensionCommandContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { CtfController, resolveWorkers, SIGNED_IN_QUESTION } from "../src/commands.ts";
import type { CtfStore } from "../src/config.ts";
import { FakeDockerCli, fakeSdk, fakeUi, model, tempStore, zod } from "./fakes.ts";

const MODELS = [model("abl", "head-model"), model("std", "worker-a")];

function ctx(ui: ExtensionUIContext): ExtensionCommandContext {
	return { ui, hasUI: true, mode: "tui", cwd: "/Users/op/project", modelRegistry: { getAvailable: () => MODELS, authStorage: {} } } as unknown as ExtensionCommandContext;
}

async function seedEvent(store: CtfStore, cli: FakeDockerCli, eventId: string, challengeId: string) {
	const volume = `omp-ctf-${eventId}-${challengeId}-work`;
	cli.volumes.set(volume, eventId);
	cli.volumes.set(`omp-ctf-${eventId}-profile`, eventId);
	await store.saveEvent({
		version: 1,
		eventId,
		name: `Event ${eventId}`,
		url: "https://old.test/",
		createdAt: new Date().toISOString(),
		challenges: [{ id: challengeId, name: "old-chal", status: "solved", volume, createdAt: new Date().toISOString() }],
	});
}

/** Controller with an active run that has one running challenge. */
async function controllerWithRun(confirmImport: boolean) {
	const store = await tempStore();
	const cli = new FakeDockerCli();
	await seedEvent(store, cli, "old-aaaaaa", "c-aaaaaaaa");
	const gate = Promise.withResolvers<void>();
	const { sdk } = fakeSdk(() => gate.promise);
	const controller = new CtfController({ sdk, z: zod, docker: cli.docker, store, openUrl: async () => true });
	const { ui, log } = fakeUi({
		select: (title, options) => {
			if (title.startsWith("Select the HEAD")) return "abl/head-model";
			if (title.startsWith("Select a standard WORKER")) return "std/worker-a";
			if (title === SIGNED_IN_QUESTION) return "Yes";
			if (title.startsWith("CTF history")) return options.find(o => o.startsWith("old-aaaaaa"));
			if (title.endsWith("select a challenge")) return options[0];
			if (title.startsWith("Import into")) return options[0];
			if (title.startsWith("Select the exact artifact")) return "flag.txt";
			return undefined;
		},
		confirm: () => confirmImport,
	});
	await controller.handle("start newctf", ctx(ui));
	const run = controller.activeRun!;
	await run.dispatch({ name: "current" });
	return { controller, cli, ui, log, store, run, release: gate.resolve };
}

describe("start", () => {
	test("dismissed head picker aborts before config, Docker or any resource", async () => {
		const store = await tempStore();
		const cli = new FakeDockerCli();
		const controller = new CtfController({ sdk: fakeSdk(async () => {}).sdk, z: zod, docker: cli.docker, store });
		const { ui, log } = fakeUi({ select: () => undefined });
		await controller.handle("", ctx(ui));
		expect(log.notify.join("\n")).toMatch(/Head model selection dismissed/);
		expect(cli.calls).toHaveLength(0);
		expect(await store.loadConfig()).toBeUndefined();
		expect(controller.activeRun).toBeUndefined();
	});

	test("head picker is never preselected and the head is never saved; second start is refused", async () => {
		const { controller, log, store, release } = await controllerWithRun(false);
		const headPick = log.select.find(s => s.title.startsWith("Select the HEAD"))!;
		expect(headPick.options).toEqual(["abl/head-model", "std/worker-a"]);
		const workerPick = log.select.find(s => s.title.startsWith("Select a standard WORKER"))!;
		expect(workerPick.options).not.toContain("abl/head-model");
		expect(await store.loadConfig()).toEqual({ version: 1, workerModels: ["std/worker-a"], autoSubmit: false, maxWorkers: 4 });
		const { ui, log: log2 } = fakeUi({ select: () => "abl/head-model" });
		await controller.handle("", ctx(ui));
		expect(log2.notify.join("\n")).toMatch(/already active.*\/ctf stop first/);
		release();
		await controller.shutdown();
	});

	test("unavailable worker model fails without fallback", () => {
		expect(() => resolveWorkers({ getAvailable: () => MODELS }, ["std/gone"])).toThrow(/no fallback/);
	});

	function signInController(answers: Array<string | undefined>, pageUrls: string[]) {
		const cli = new FakeDockerCli();
		cli.pageUrls = pageUrls;
		const gate = Promise.withResolvers<void>();
		const opened: string[] = [];
		const fake = fakeSdk(() => gate.promise);
		const { ui, log } = fakeUi({
			select: title => {
				if (title.startsWith("Select the HEAD")) return "abl/head-model";
				if (title.startsWith("Select a standard WORKER")) return "std/worker-a";
				if (title === SIGNED_IN_QUESTION) return answers.shift();
				return undefined;
			},
		});
		return { cli, ui, log, opened, fake, release: gate.resolve, store: tempStore(), openUrl: async (url: string) => (opened.push(url), true) };
	}

	test("bare /ctf opens the contained browser, asks the sign-in question, and adopts the signed-in page", async () => {
		const t = signInController(["Yes"], ["https://ctf.test/challenges"]);
		const controller = new CtfController({ sdk: t.fake.sdk, z: zod, docker: t.cli.docker, store: await t.store, openUrl: t.openUrl });
		await controller.handle("", ctx(t.ui));
		expect(t.opened).toHaveLength(1);
		expect(t.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:49999\/vnc\.html\?/);
		const question = t.log.select.find(s => s.title === SIGNED_IN_QUESTION)!;
		expect(question.options).toEqual(["Yes", "No"]);
		// Nothing navigates the browser before the operator answers; the only driver call reads the page.
		const driver = t.cli.calls.filter(c => c.argv.includes("/opt/ctf-driver/driver.mjs"));
		expect(driver.map(c => JSON.parse(String(c.options?.stdin)).op)).toEqual(["observe"]);
		const run = controller.activeRun!;
		expect(run.url).toBe("https://ctf.test/challenges");
		expect(run.eventName).toBe("ctf.test");
		await t.fake.waitForPrompts(1);
		expect(t.fake.sessions[0]?.prompts[0]).toContain("Event URL: https://ctf.test/challenges");
		t.release();
		await controller.shutdown();
	});

	test("answering No cancels: no model session, containers removed, profile kept", async () => {
		const t = signInController(["No"], ["https://ctf.test/"]);
		const controller = new CtfController({ sdk: t.fake.sdk, z: zod, docker: t.cli.docker, store: await t.store, openUrl: t.openUrl });
		await controller.handle("", ctx(t.ui));
		expect(controller.activeRun).toBeUndefined();
		expect(t.fake.sessions).toHaveLength(0);
		expect(t.cli.containers.size).toBe(0);
		expect([...t.cli.volumes.keys()].some(v => v.endsWith("-profile"))).toBe(true);
	});

	test("Yes while the browser is not on an http(s) page asks again", async () => {
		const t = signInController(["Yes", "Yes"], ["about:blank", "https://ctf.test/home"]);
		const controller = new CtfController({ sdk: t.fake.sdk, z: zod, docker: t.cli.docker, store: await t.store, openUrl: t.openUrl });
		await controller.handle("", ctx(t.ui));
		expect(t.log.select.filter(s => s.title === SIGNED_IN_QUESTION)).toHaveLength(2);
		expect(t.log.notify.join("\n")).toMatch(/not showing an http\(s\) page/);
		expect(controller.activeRun?.url).toBe("https://ctf.test/home");
		t.release();
		await controller.shutdown();
	});
});

describe("history import", () => {
	test("denied import copies nothing", async () => {
		const { controller, cli, ui, log, release } = await controllerWithRun(false);
		await controller.handle("history", ctx(ui));
		expect(log.confirm.at(-1)?.message).toMatch(/Artifact: flag\.txt/);
		expect(cli.calls.some(c => c.argv.includes("import"))).toBe(false);
		expect(log.notify.join("\n")).toMatch(/Nothing from history was shared/);
		release();
		await controller.shutdown();
	});

	test("approved import copies exactly the selected artifact into the selected challenge", async () => {
		const { controller, cli, ui, run, release } = await controllerWithRun(true);
		await controller.handle("history", ctx(ui));
		const imports = cli.calls.filter(c => c.argv.includes("import"));
		expect(imports).toHaveLength(1);
		const argv = imports[0]!.argv;
		const target = run.challengeIds()[0]!;
		expect(argv.slice(-2)).toEqual(["/dst/imported/c-aaaaaaaa", "flag.txt"]);
		expect(argv).toContain("omp-ctf-old-aaaaaa-c-aaaaaaaa-work:/src:ro");
		expect(argv).toContain(`omp-ctf-${run.eventId}-${target}-work:/dst`);
		release();
		await controller.shutdown();
	});
});

describe("purge", () => {
	test("deletes only the confirmed event's volumes and metadata", async () => {
		const store = await tempStore();
		const cli = new FakeDockerCli();
		await seedEvent(store, cli, "keep-111111", "c-11111111");
		await seedEvent(store, cli, "drop-222222", "c-22222222");
		const controller = new CtfController({ sdk: fakeSdk(async () => {}).sdk, z: zod, docker: cli.docker, store });
		const declined = fakeUi({ confirm: () => false });
		await controller.handle("purge drop-222222", ctx(declined.ui));
		expect(cli.volumes.size).toBe(4);
		const approved = fakeUi({ confirm: () => true });
		await controller.handle("purge drop-222222", ctx(approved.ui));
		expect([...cli.volumes.keys()].sort()).toEqual(["omp-ctf-keep-111111-c-11111111-work", "omp-ctf-keep-111111-profile"]);
		expect(await store.loadEvent("drop-222222")).toBeUndefined();
		expect(await store.loadEvent("keep-111111")).toBeDefined();
	});

	test("rejects invalid event ids", async () => {
		const cli = new FakeDockerCli();
		const controller = new CtfController({ sdk: fakeSdk(async () => {}).sdk, z: zod, docker: cli.docker, store: await tempStore() });
		const { ui, log } = fakeUi({ confirm: () => true });
		await controller.handle("purge ../x", ctx(ui));
		expect(log.notify.join("\n")).toMatch(/Invalid event id/);
		expect(cli.calls).toHaveLength(0);
	});
});
