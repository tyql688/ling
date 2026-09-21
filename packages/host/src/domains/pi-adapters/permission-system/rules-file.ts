import { mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Match pi-permission-system's config locations, including Pi's isolated agent directory. */
export async function prepareRulesFile(cwd: string | null): Promise<string> {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const agentDir = configured ? configured.replace(/^~(?=$|[/\\])/, homedir()) : join(homedir(), ".pi", "agent");
	if (cwd && !(await stat(cwd)).isDirectory()) throw new Error("The project path is not a directory");
	const path = resolve(cwd ? join(cwd, ".pi") : agentDir, "extensions", "pi-permission-system", "config.json");
	await mkdir(dirname(path), { recursive: true });
	try {
		const file = await open(path, "wx", 0o600);
		try {
			// An empty config adds no overrides to pi-permission-system's existing global, legacy or project rules.
			await file.writeFile("{}\n");
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (!(await stat(path)).isFile()) throw new Error("The permission configuration path is not a file");
	}
	return path;
}
