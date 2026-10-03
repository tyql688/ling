import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { errorCode } from "@ling/contracts/ling-error";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPiSettingsFileStore } from "../settings/global-settings-store";

async function readStoredSettings(path: string): Promise<Record<string, unknown>> {
	try {
		await access(path);
	} catch (error) {
		// Pi settings are optional; discovering sessions must not create a project's .pi directory.
		if (errorCode(error) === "ENOENT") return {};
		throw error;
	}
	return createPiSettingsFileStore(path).read();
}

/** Pi permits session location lookup before loading trusted project resources. */
export async function piSessionDirectory(cwd: string): Promise<string> {
	// Yield while another settings operation owns the lock, including operations in this worker.
	const [global, project] = await Promise.all([
		readStoredSettings(join(getAgentDir(), "settings.json")),
		readStoredSettings(join(cwd, ".pi", "settings.json")),
	]);
	const settings = SettingsManager.fromStorage({
		withLock(scope, read) {
			if (read(JSON.stringify(scope === "global" ? global : project)) !== undefined)
				throw new Error("Session storage inspection cannot write settings");
		},
	});
	const errors = settings.drainErrors();
	if (errors.length > 0)
		throw new AggregateError(
			errors.map(({ error }) => error),
			"Failed to resolve Pi session storage",
		);
	const configured = process.env.PI_CODING_AGENT_SESSION_DIR || settings.getSettings().sessionDir;
	if (configured !== undefined) {
		if (typeof configured !== "string" || configured.includes("\0")) throw new Error("Invalid Pi sessionDir");
		if (configured) return resolve(cwd, configured.replace(/^~(?=[/\\]|$)/, homedir()));
	}
	return defaultPiSessionDirectory(cwd);
}

/** Pi's default directory encoding is kept here until the SDK exports its resolver. */
export function defaultPiSessionDirectory(cwd: string): string {
	const encoded = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(getAgentDir()), "sessions", encoded);
}

/** Configured and default locations remain readable when a project changes its storage choice. */
export async function piSessionDirectories(cwd: string): Promise<string[]> {
	return [...new Set([await piSessionDirectory(cwd), defaultPiSessionDirectory(cwd)])];
}

/** Usage includes CLI history and the effective storage of every open conversation target. */
export async function piUsageSessionDirectories(cwds: readonly string[]): Promise<string[]> {
	const directories = await Promise.all(cwds.map(piSessionDirectories));
	return [...new Set([join(resolve(getAgentDir()), "sessions"), ...directories.flat()])];
}
