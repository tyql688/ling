import { afterEach, describe, expect, it } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createEditorLanguageService } from "./language-service";
import { createLanguageFrameLimit } from "./language-process";
import { normalizeWorkspaceEdit } from "./workspace-edits";
import { pathToFileURL } from "node:url";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
describe("project language ownership", () => {
	it("reads project configuration, shares documents, fences stale edits and releases the real server", async () => {
		const cwd = await temporaryDirectory("language");
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		await writeFile(
			join(cwd, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "bundler",
					noEmit: true,
				},
				include: ["*.ts"],
			}),
		);
		await writeFile(join(cwd, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
		const text = 'import { add } from "./math";\nconst answer: string = add(1, 2);\nconsole.log(answer);\n';
		await writeFile(join(cwd, "main.ts"), text);
		const failures: Error[] = [];
		const service = createEditorLanguageService({
			isTrusted: async () => false,
			onDiagnostics() {},
			onError: (error) => failures.push(error),
		});
		cleanups.push(service.dispose);
		const connection = await service.open(
			"client",
			{ cwd, path: "main.ts", language: "typescript", version: 1, text },
			new AbortController().signal,
		);
		expect(connection?.capabilities.definitionProvider).toBeTruthy();
		const call = (method: "diagnostics" | "definition" | "rename", version = 1) =>
			service.call(
				"client",
				{
					id: connection!.id,
					requestId: crypto.randomUUID(),
					path: "main.ts",
					version,
					method,
					position: { line: 1, character: 23 },
					newName: "sum",
				},
				new AbortController().signal,
			);
		const diagnostic = await call("diagnostics");
		expect(diagnostic.data).toMatchObject({
			kind: "full",
			items: expect.arrayContaining([expect.objectContaining({ code: 2322 })]),
		});
		const definition = await call("definition");
		expect(JSON.stringify(definition.data)).toContain("math.ts");
		await writeFile(join(cwd, "math.ts"), "export function add(a: number, b: number) { return String(a + b); }\n");
		await expect
			.poll(async () => (await call("diagnostics")).data, { timeout: 5_000 })
			.toMatchObject({ kind: "full", items: [] });
		await writeFile(join(cwd, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
		await expect
			.poll(async () => (await call("diagnostics")).data, { timeout: 5_000 })
			.toMatchObject({
				kind: "full",
				items: expect.arrayContaining([expect.objectContaining({ code: 2322 })]),
			});
		const rename = await call("rename");
		expect(rename.change?.files.map((file) => file.path)).toEqual(["main.ts"]);
		await service.open(
			"client",
			{
				cwd,
				path: "math.ts",
				language: "typescript",
				version: 1,
				text: "export function add(a: number, b: number) { return a + b; }\n",
			},
			new AbortController().signal,
		);
		const exportedRename = await service.call(
			"client",
			{
				id: connection!.id,
				requestId: crypto.randomUUID(),
				path: "math.ts",
				version: 1,
				method: "rename",
				position: { line: 0, character: 17 },
				newName: "sum",
			},
			new AbortController().signal,
		);
		expect(exportedRename.change?.files.map((file) => file.path).sort()).toEqual(["main.ts", "math.ts"]);
		await expect(
			service.call(
				"other-client",
				{ id: connection!.id, requestId: "cross-client", path: "main.ts", version: 1, method: "symbols" },
				new AbortController().signal,
			),
		).rejects.toThrow("connection");
		await service.change("client", connection!.id, {
			cwd,
			path: "main.ts",
			language: "typescript",
			version: 2,
			text: text.replace("answer: string", "answer: number"),
		});
		await expect(call("diagnostics")).rejects.toThrow("stale");
		expect((await call("diagnostics", 2)).data).toMatchObject({ kind: "full", items: [] });
		const fixText = "const value = add(1, 2);\nconsole.log(value);\n";
		await writeFile(join(cwd, "fix.ts"), fixText);
		await service.open(
			"client",
			{ cwd, path: "fix.ts", language: "typescript", version: 1, text: fixText },
			new AbortController().signal,
		);
		const fixCall = (method: "diagnostics" | "codeActions" | "action", ticket?: string) =>
			service.call(
				"client",
				{
					id: connection!.id,
					requestId: crypto.randomUUID(),
					path: "fix.ts",
					version: 1,
					method,
					range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
					...(ticket ? { ticket } : {}),
				},
				new AbortController().signal,
			);
		await fixCall("diagnostics");
		const actions = (await fixCall("codeActions")).data as Array<{ title: string; lingTicket: string }>;
		const importAction = actions.find((action) => action.title.includes("Add import"));
		expect(importAction, JSON.stringify(actions)).toBeDefined();
		const fix = await fixCall("action", importAction!.lingTicket);
		expect(fix.change?.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "fix.ts" })]));
		await service.releaseClient("client");
		expect(() => service.cwd("client", connection!.id)).toThrow("Unknown");
		expect(failures).toEqual([]);
	}, 30_000);
	it("rejects out-of-project edits and unsupported resource operations", async () => {
		const cwd = await temporaryDirectory("language-edits");
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		await expect(
			normalizeWorkspaceEdit(
				cwd,
				{ changes: { [pathToFileURL(join(cwd, "..", "outside.ts")).href]: [] } },
				new Map(),
				"rename",
			),
		).rejects.toThrow();
		await expect(
			normalizeWorkspaceEdit(
				cwd,
				{ documentChanges: [{ kind: "delete", uri: pathToFileURL(join(cwd, "file.ts")).href }] },
				new Map(),
				"delete",
			),
		).rejects.toThrow();
	});
	it("bounds announced frames before allocation, including split headers", async () => {
		const stream = createLanguageFrameLimit();
		stream.resume();
		const error = once(stream, "error");
		stream.write("Content-Len");
		stream.write("gth: 999999999\r\n\r\n");
		expect((await error)[0]).toMatchObject({ message: expect.stringContaining("budget") });
	});
});
