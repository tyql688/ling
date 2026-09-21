import { spawn } from "node:child_process";
import { z } from "zod";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { access } from "node:fs/promises";
import { languageLimits, type EditorDocument, type Range, type TextEdit } from "@ling/contracts/editor-language";
import { readUtf8FileBounded } from "@ling/core/store/atomic-file-store";
import { toCommandError } from "@ling/core/command-resolver";
import { terminateProcessTree } from "@ling/node-runtime/process-tree-terminator";
import { resolveExistingProjectPath } from "../files/project-files";

async function runFormatter(
	cli: string,
	args: string[],
	cwd: string,
	text: string,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const child = spawn(process.execPath, [cli, ...args], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	let output = "",
		stderr = "";
	try {
		return await new Promise<string>((resolve, reject) => {
			// Formatter configuration is executable project code and runs only in this bounded child.
			const timer = setTimeout(() => reject(new Error("Project formatter timed out")), 15_000);
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			};
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (output.length > languageLimits.text) {
					cleanup();
					reject(new Error("Formatter output exceeds the document budget"));
				}
			});
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-8_192);
			});
			child.on("error", (error) => {
				cleanup();
				reject(toCommandError(error));
			});
			child.stdin.on("error", (error) => {
				cleanup();
				reject(toCommandError(error));
			});
			child.on("close", (code) => {
				cleanup();
				if (code === 0) resolve(output);
				else reject(new Error(stderr || `Formatter exited with code ${code}`));
			});
			child.stdin.end(text);
		});
	} finally {
		if (child.pid !== undefined)
			await terminateProcessTree({
				pid: child.pid,
				terminateRoot: () => {
					child.kill();
				},
				rootExited: () => child.exitCode !== null || child.signalCode !== null,
			});
	}
}
function offset(text: string, position: Range["start"]): number {
	let index = 0;
	for (let line = 0; line < position.line; line++) {
		const end = text.indexOf("\n", index);
		if (end < 0) throw new Error("Selection is outside the document");
		index = end + 1;
	}
	const end = text.indexOf("\n", index),
		limit = end < 0 ? text.length : end;
	if (index + position.character > limit) throw new Error("Selection column is outside the document");
	return index + position.character;
}
export async function formatProjectDocument(
	document: EditorDocument,
	range: Range | undefined,
	trusted: boolean,
	signal: AbortSignal,
): Promise<TextEdit[] | null> {
	const file = await resolveExistingProjectPath(document.cwd, document.path);
	const require = createRequire(join(document.cwd, "package.json"));
	async function packageCli(name: string): Promise<string | null> {
		let path: string;
		try {
			path = require.resolve(`${name}/package.json`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return null;
			throw error;
		}
		const source = await readUtf8FileBounded(path, 256 * 1_024);
		if (source === undefined) throw new Error(`Formatter package disappeared: ${name}`);
		const metadata = z
			.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]) })
			.parse(JSON.parse(source));
		const bin =
			typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[name === "prettier" ? "prettier" : "biome"];
		if (!bin) throw new Error(`Formatter has no CLI: ${name}`);
		return resolve(dirname(path), bin);
	}
	let biomeConfigured = false;
	for (const path of ["biome.json", "biome.jsonc"])
		try {
			await access(join(document.cwd, path));
			biomeConfigured = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	const prettier = await packageCli("prettier"),
		biome = biomeConfigured ? await packageCli("@biomejs/biome") : null;
	if (!prettier && !biome) return null;
	if (!trusted) throw new Error("Trust this project before running its formatter configuration");
	let formatted: string;
	if (biome && !range)
		formatted = await runFormatter(biome, ["format", `--stdin-file-path=${file}`], document.cwd, document.text, signal);
	else if (prettier)
		formatted = await runFormatter(
			prettier,
			[
				"--stdin-filepath",
				file,
				...(range
					? [
							"--range-start",
							String(offset(document.text, range.start)),
							"--range-end",
							String(offset(document.text, range.end)),
						]
					: []),
			],
			document.cwd,
			document.text,
			signal,
		);
	else return null; // Biome has no selection-formatting CLI; the language provider can handle this operation.
	const lines = document.text.split("\n");
	return formatted === document.text
		? []
		: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } },
					newText: formatted,
				},
			];
}
