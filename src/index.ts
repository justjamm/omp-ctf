/**
 * omp-ctf extension: registers `/ctf`. The ordinary session keeps its own model and tools; CTF work
 * runs only in isolated SDK sessions with container-mediated `ctf_*` tools (see runtime.ts).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CtfController, USAGE } from "./commands.ts";

const SUBCOMMANDS = ["start", "status", "stop", "settings", "history", "purge", "reset-config", "help"];

export default function ctfExtension(pi: ExtensionAPI): void {
	const controller = new CtfController({ sdk: pi.pi, z: pi.zod });

	pi.registerCommand("ctf", {
		description: "Containerized, operator-supervised CTF automation",
		getArgumentCompletions: prefix => {
			if (prefix.includes(" ")) {
				if (prefix.startsWith("settings ")) return [{ value: "settings auto-submit on", label: "auto-submit on" }, { value: "settings auto-submit off", label: "auto-submit off" }];
				return null;
			}
			const matches = SUBCOMMANDS.filter(sub => sub.startsWith(prefix));
			return matches.length > 0 ? matches.map(sub => ({ value: sub, label: sub })) : null;
		},
		handler: async (args, ctx) => controller.handle(args, ctx),
	});

	pi.on("session_shutdown", async () => {
		await controller.shutdown();
	});

	pi.logger.debug("omp-ctf loaded", { usage: USAGE });
}
