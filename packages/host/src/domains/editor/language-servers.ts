import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";

const hostRequire = createRequire(import.meta.url);
export interface LanguageServerLaunch {
	id: string;
	name: string;
	revision: string;
	command: string;
	args: string[];
	initializationOptions: unknown;
}
export async function resolveLanguageServer(
	cwd: string,
	language: string,
	trusted: boolean,
): Promise<LanguageServerLaunch | null> {
	if (!["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(language)) return null;
	let packagePath = hostRequire.resolve("@typescript/native/package.json");
	// Only execute project tooling after Pi's existing project trust decision. Native TS exposes its CLI as bin/tsc.
	if (trusted) {
		const projectRequire = createRequire(join(cwd, "package.json"));
		for (const name of ["@typescript/native", "typescript"]) {
			let candidate: string;
			try {
				candidate = projectRequire.resolve(`${name}/package.json`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") continue;
				throw error;
			}
			const metadata = projectRequire(candidate) as { version?: string };
			if (metadata.version?.startsWith("7.")) {
				packagePath = candidate;
				break;
			}
		}
	}
	const cli = join(dirname(packagePath), "bin", "tsc");
	await access(cli);
	return {
		id: "typescript",
		name: "TypeScript",
		revision: cli,
		command: process.execPath,
		args: [cli, "--lsp", "--stdio"],
		initializationOptions: null,
	};
}
