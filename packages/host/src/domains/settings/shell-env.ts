import { createLogger } from "@ling/core/logger";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const log = createLogger("shell-env");
const execFileAsync = promisify(execFile);

/**
 * Separator marker for login-shell output. rc banners print before the marker; the
 * `env -0` body follows it. A unique string avoids colliding with user echo, so
 * lastIndexOf cuts reliably.
 */
const MARKER = "__LING_SHELL_ENV__";

/**
 * The pi CLI always runs inside the user's login shell, so it inherits every terminal
 * export — http_proxy/https_proxy, the real PATH, API keys. A Dock-launched GUI app gets
 * none of that, which is exactly why "pi works in my terminal but not in Ling". Importing
 * the login shell's environment at startup makes Ling behave identically to `pi` run from
 * a terminal. Missing keys are merged; PATH is adopted outright (the Dock PATH is a stub
 * that would also break pi's bash tool and npm-based plugin installs).
 */
export async function importLoginShellEnv(): Promise<void> {
	if (process.platform !== "darwin") return;
	const shell = process.env.SHELL ?? "/bin/zsh";
	try {
		const { stdout } = await execFileAsync(shell, ["-ilc", `printf '%s' '${MARKER}'; command env -0`], {
			// One login-shell launch is enough; the 8s timeout keeps a broken rc file from stalling main-process startup
			timeout: 8_000,
			// Environment output cap 4MiB
			maxBuffer: 4 * 1024 * 1024,
		});
		const start = stdout.lastIndexOf(MARKER);
		if (start < 0) throw new Error("marker not found in shell output");
		const pairs = stdout
			.slice(start + MARKER.length)
			.split("\0")
			.filter(Boolean);
		let merged = 0;
		for (const pair of pairs) {
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const key = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			if (key === "PATH") {
				if (process.env.PATH !== value) {
					process.env.PATH = value;
					merged++;
				}
				continue;
			}
			if (!(key in process.env)) {
				process.env[key] = value;
				merged++;
			}
		}
		log.info(`imported ${merged} env vars from login shell (${shell})`);
	} catch (error) {
		// Startup must not die on a broken rc file — but say so loudly.
		log.warn(`could not import login shell env from ${shell}:`, error);
	}
}
