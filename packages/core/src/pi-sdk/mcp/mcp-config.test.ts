import { readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createMcpConfigFile } from "./mcp-config";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await temporaryDirectory("mcp-config");
	roots.push(root);
	const path = join(root, "mcp.json");
	return { root, path, file: createMcpConfigFile(path), signal: new AbortController().signal };
}

it("preserves comments, unknown options and unrelated credentials while disabling one service", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		'{\n  // shared with Pi\n  "settings": {"futureOption": 42},\n  "mcpServers": {"remote": {"url":"https://example.com/mcp","headers":{"Authorization":"fixture-secret"}}, "local": {"command":"node","customOption":true}}\n}\n',
	);
	const before = await f.file.read();
	await f.file.write(
		{ expectedRevision: before.revision, name: "local", change: { kind: "toggle", disabled: true } },
		f.signal,
	);
	const after = await f.file.read();
	expect(after.servers.remote).toEqual(before.servers.remote);
	expect(after.servers.local).toEqual({ command: "node", customOption: true, disabled: true });
	const source = await readFile(f.path, "utf8");
	expect(source).toContain("// shared with Pi");
	expect(source).toContain('"futureOption": 42');
});

it("creates private project overrides without copying inherited credentials and removes only that entry", async () => {
	const f = await fixture();
	const before = await f.file.read();
	expect(before.exists).toBe(false);
	await f.file.write(
		{ expectedRevision: before.revision, name: "remote", change: { kind: "toggle", disabled: true } },
		f.signal,
	);
	const after = await f.file.read();
	expect(after.servers).toEqual({ remote: { disabled: true } });
	if (process.platform !== "win32") expect((await stat(f.path)).mode & 0o777).toBe(0o600);
	await f.file.write({ expectedRevision: after.revision, name: "remote", change: { kind: "remove" } }, f.signal);
	expect((await f.file.read()).servers).toEqual({});
});

it("rejects stale and concurrent edits instead of losing the previous write", async () => {
	const f = await fixture();
	const before = await f.file.read();
	const inputs = ["one", "two"].map((name) => ({
		expectedRevision: before.revision,
		name,
		change: { kind: "save" as const, server: { command: "node" } },
	}));
	const results = await Promise.allSettled(inputs.map((input) => createMcpConfigFile(f.path).write(input, f.signal)));
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(Object.keys((await f.file.read()).servers)).toHaveLength(1);
	await expect(f.file.write(inputs[1]!, f.signal)).rejects.toMatchObject({ code: "MCP_CONFIG_CHANGED" });
});

it("keeps unchanged JSONC untouched and reports no mutation for saves, patches and overrides", async () => {
	const f = await fixture();
	const source = '{ "mcpServers": { "local": { "disabled": true, /* keep */ "command": "node" } } }\n';
	await writeFile(f.path, source);
	const before = await f.file.read();
	for (const change of [
		{ kind: "save" as const, server: { command: "node", disabled: true } },
		{ kind: "patch" as const, server: { command: "node" }, removeFields: [] },
		{ kind: "toggle" as const, disabled: true },
	]) {
		await expect(f.file.write({ expectedRevision: before.revision, name: "local", change }, f.signal)).resolves.toBe(
			false,
		);
	}
	for (const kind of ["remove", "reset-disabled"] as const)
		await expect(
			f.file.write({ expectedRevision: before.revision, name: "missing", change: { kind } }, f.signal),
		).resolves.toBe(false);
	expect(await readFile(f.path, "utf8")).toBe(source);
	expect((await f.file.read()).revision).toBe(before.revision);
	await expect(
		f.file.write(
			{ expectedRevision: before.revision, name: "local", change: { kind: "toggle", disabled: false } },
			f.signal,
		),
	).resolves.toBe(true);
});

it("merges conversation patches without exposing or replacing saved credentials", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		JSON.stringify({
			mcpServers: {
				remote: {
					url: "https://example.com/mcp",
					headers: { Authorization: "fixture-secret" },
					env: { TOKEN: "another-secret" },
					customOption: 42,
				},
			},
		}),
	);
	const before = await f.file.read();
	await f.file.write(
		{
			expectedRevision: before.revision,
			name: "remote",
			change: {
				kind: "patch",
				server: { headers: { Accept: "application/json" }, env: { MODE: "test" }, approveTools: true },
				removeFields: [],
			},
		},
		f.signal,
	);
	expect((await f.file.read()).servers.remote).toEqual({
		...before.servers.remote,
		headers: { Authorization: "fixture-secret", Accept: "application/json" },
		env: { TOKEN: "another-secret", MODE: "test" },
		approveTools: true,
	});
	const latest = await f.file.read();
	await expect(
		f.file.write(
			{
				expectedRevision: latest.revision,
				name: "remote",
				change: {
					kind: "patch",
					server: { url: "https://other.example/mcp" },
					removeFields: [],
				},
			},
			f.signal,
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	expect((await f.file.read()).revision).toBe(latest.revision);
});

it("requires an explicit transport removal and defaults new services to approval", async () => {
	const f = await fixture();
	await f.file.write(
		{
			expectedRevision: (await f.file.read()).revision,
			name: "local",
			change: {
				kind: "patch",
				server: { command: "node", args: ["fixture.js"] },
				removeFields: [],
			},
		},
		f.signal,
	);
	const before = await f.file.read();
	expect(before.servers.local?.approveTools).toBe(true);
	await expect(
		f.file.write(
			{
				expectedRevision: before.revision,
				name: "local",
				change: {
					kind: "patch",
					server: { url: "https://example.com/mcp" },
					removeFields: [],
				},
			},
			f.signal,
		),
	).rejects.toThrow("explicit removeFields");
	expect((await f.file.read()).revision).toBe(before.revision);
	await f.file.write(
		{
			expectedRevision: before.revision,
			name: "local",
			change: {
				kind: "patch",
				server: { url: "https://example.com/mcp" },
				removeFields: ["command", "args"],
			},
		},
		f.signal,
	);
	expect((await f.file.read()).servers.local).toEqual({ url: "https://example.com/mcp", approveTools: true });
});

it("restores inherited enable state without dropping other project options", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		'{ // keep project options\n "mcpServers": {"partial":{"disabled":true,"env":{"MODE":"test"}},"only":{"disabled":false}}}\n',
	);
	for (const name of ["partial", "only", "missing"]) {
		const current = await f.file.read();
		await f.file.write({ expectedRevision: current.revision, name, change: { kind: "reset-disabled" } }, f.signal);
	}
	expect((await f.file.read()).servers).toEqual({ partial: { env: { MODE: "test" } } });
	expect(await readFile(f.path, "utf8")).toContain("// keep project options");
});

it("saves a retained draft against a refreshed revision without replacing another service", async () => {
	const f = await fixture();
	const before = await f.file.read();
	const draft = { name: "draft", change: { kind: "save" as const, server: { command: "node", approveTools: true } } };
	await writeFile(f.path, '{"mcpServers":{"external":{"url":"https://example.com/mcp"}}}\n');
	await expect(f.file.write({ ...draft, expectedRevision: before.revision }, f.signal)).rejects.toMatchObject({
		code: "MCP_CONFIG_CHANGED",
	});
	const latest = await f.file.read();
	await f.file.write({ ...draft, expectedRevision: latest.revision }, f.signal);
	expect((await f.file.read()).servers).toEqual({ external: latest.servers.external, draft: draft.change.server });
});

it.each(["{broken", '{"mcpServers":{"bad":{"command":false}}}', '{"mcpServers":[]}'])(
	"does not overwrite unreadable configuration: %s",
	async (source) => {
		const f = await fixture();
		const before = await f.file.read();
		await writeFile(f.path, source);
		await expect(f.file.read()).rejects.toThrow();
		await expect(
			f.file.write(
				{ expectedRevision: before.revision, name: "new", change: { kind: "save", server: { command: "node" } } },
				f.signal,
			),
		).rejects.toThrow();
		expect(await readFile(f.path, "utf8")).toBe(source);
	},
);

it("keeps a dotfile symlink when editing its target", async () => {
	const f = await fixture();
	const target = join(f.root, "shared.json");
	await writeFile(target, '{ "mcpServers": {} }\n');
	await symlink(target, f.path);
	const before = await f.file.read();
	await f.file.write(
		{ expectedRevision: before.revision, name: "local", change: { kind: "save", server: { command: "node" } } },
		f.signal,
	);
	expect(JSON.parse(await readFile(target, "utf8")).mcpServers.local).toEqual({ command: "node" });
	expect((await f.file.read()).servers.local).toEqual({ command: "node" });
});

it("retains upstream aliases, trailing commas and environment references without creating a shadow map", async () => {
	const f = await fixture();
	await writeFile(f.path, '{ // existing Pi configuration\n "mcp-servers": { "我的 MCP": {"url":"${MCP_URL}",}, }, }');
	const before = await f.file.read();
	expect(before.servers["我的 MCP"]).toEqual({ url: "${MCP_URL}" });
	await f.file.write(
		{ expectedRevision: before.revision, name: "我的 MCP", change: { kind: "toggle", disabled: true } },
		f.signal,
	);
	expect((await f.file.read()).servers["我的 MCP"]).toEqual({ url: "${MCP_URL}", disabled: true });
	expect(await readFile(f.path, "utf8")).not.toContain('"mcpServers"');
});

it("reports BOM files that the upstream loader rejects, without rewriting them", async () => {
	const f = await fixture();
	const before = await f.file.read();
	const source = '\uFEFF{"mcpServers":{}}';
	await writeFile(f.path, source);
	await expect(f.file.read()).rejects.toThrow("BOM");
	await expect(
		f.file.write(
			{ expectedRevision: before.revision, name: "local", change: { kind: "toggle", disabled: true } },
			f.signal,
		),
	).rejects.toThrow("BOM");
	expect(await readFile(f.path, "utf8")).toBe(source);
});
