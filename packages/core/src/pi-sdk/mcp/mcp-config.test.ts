import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createMcpConfigFile } from "./mcp-config";
import { readPiMcpConfiguration } from "./pi-mcp";
import {
	mcpConfiguredServerSchema,
	mcpServerSchema,
	mcpWriteRequestSchema,
	type McpWriteRequest,
} from "@ling/contracts/mcp";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await temporaryDirectory("mcp-config");
	roots.push(root);
	const path = join(root, "mcp.json");
	return { root, path, file: createMcpConfigFile(path, "global"), signal: new AbortController().signal };
}

it("isolates malformed MCP options and names while keeping valid services editable", async () => {
	const f = await fixture();
	const oversizedName = "x".repeat(201);
	await writeFile(
		f.path,
		JSON.stringify({
			autoEnableCodemode: "false",
			mcpServers: { good: { command: "node" }, [oversizedName]: { command: "node" }, "": { command: "node" } },
		}),
	);
	const snapshot = await readPiMcpConfiguration(f.root, null);
	expect(snapshot.loaded.servers.map((server) => server.name)).toEqual(["good"]);
	expect(snapshot.loaded.errors).toHaveLength(3);
	expect(snapshot.documents[0]?.error).toBeNull();
	for (const name of [oversizedName, ""]) {
		const input = mcpWriteRequestSchema.parse({
			cwd: null,
			target: "global",
			expectedRevision: (await f.file.read()).revision,
			name,
			change: { kind: "remove" },
		});
		await f.file.write(input, f.signal);
	}
	expect((await f.file.read()).servers).toEqual({ good: { command: "node" } });
});

it("rejects OAuth callbacks whose configured ports disagree", () => {
	expect(
		mcpConfiguredServerSchema.safeParse({
			url: "https://example.com/mcp",
			oauth: { callbackUrl: "http://localhost:43210/callback", callbackPort: 43211 },
		}).success,
	).toBe(false);
});

it("normalizes exposure aliases without rewriting saved configuration", async () => {
	const f = await fixture();
	const stored = {
		command: "node",
		description: "Search fixture documents",
		exposure: "codemode-deferred",
		toolExposure: { "read-*": "codemode-deferred" },
	};
	const source = JSON.stringify({ mcpServers: { docs: stored } });
	await writeFile(f.path, source);
	const snapshot = await readPiMcpConfiguration(f.root, null);
	expect(snapshot.loaded.errors).toEqual([]);
	expect(snapshot.loaded.servers[0]?.config).toEqual({
		...stored,
		exposure: "codemode",
		toolExposure: { "read-*": "codemode" },
	});
	expect(snapshot.documents[0]?.servers?.docs).toEqual(stored);
	expect(await readFile(f.path, "utf8")).toBe(source);
});

it("validates OAuth metadata destinations while preserving editable drafts", () => {
	for (const authServerMetadataUrl of [
		"https://login.example.com/.well-known/openid-configuration",
		"http://localhost:9000/metadata",
		"http://127.0.0.1:9000/metadata",
		"http://[::1]:9000/metadata",
	])
		expect(
			mcpConfiguredServerSchema.parse({ url: "https://example.com/mcp", oauth: { authServerMetadataUrl } }).oauth,
		).toEqual({ authServerMetadataUrl });
	for (const authServerMetadataUrl of [
		"https://",
		"http://example.com/metadata",
		"http://localhost.evil.test/metadata",
		"file:///metadata.json",
	]) {
		const server = { url: "https://example.com/mcp", oauth: { authServerMetadataUrl } };
		expect(mcpServerSchema.safeParse(server).success).toBe(true);
		expect(mcpConfiguredServerSchema.safeParse(server).success).toBe(false);
	}
});

it("persists OAuth metadata through Pi and rejects invalid updates without changing the file", async () => {
	const f = await fixture();
	const server = {
		url: "https://example.com/mcp",
		oauth: {
			clientName: "ling-fixture",
			authServerMetadataUrl: "https://login.example.com/.well-known/openid-configuration",
			futureOption: "retained",
		},
	};
	await f.file.write(
		{ expectedRevision: (await f.file.read()).revision, name: "remote", change: { kind: "save", server } },
		f.signal,
	);
	const snapshot = await readPiMcpConfiguration(f.root, null);
	expect(snapshot.loaded.errors).toEqual([]);
	expect(snapshot.loaded.servers[0]).toMatchObject({ config: { oauth: server.oauth } });
	const before = await f.file.read();
	await expect(
		f.file.write(
			{
				expectedRevision: before.revision,
				name: "remote",
				change: {
					kind: "patch",
					server: { oauth: { authServerMetadataUrl: "http://remote.example/metadata" } },
					removeFields: [],
				},
			},
			f.signal,
		),
	).rejects.toThrow("OAuth metadata");
	expect((await f.file.read()).revision).toBe(before.revision);
	expect((await f.file.read()).servers.remote).toEqual(server);
});

it("limits provider authentication to secure HTTP endpoints and preserves OAuth client names", () => {
	for (const url of [
		"https://example.com/mcp",
		"http://localhost:9000/mcp",
		"http://127.0.0.1:9000/mcp",
		"http://[::1]:9000/mcp",
	])
		expect(
			mcpConfiguredServerSchema.parse({ url, auth: { provider: "fixture" }, oauth: { clientName: "fixture-client" } }),
		).toMatchObject({ auth: { provider: "fixture" }, oauth: { clientName: "fixture-client" } });
	for (const connection of [
		{ command: "node" },
		{ url: "http://example.com/mcp" },
		{ url: "http://localhost.evil.test/mcp" },
		{ url: "invalid" },
	])
		expect(mcpConfiguredServerSchema.safeParse({ ...connection, auth: { provider: "fixture" } }).success).toBe(false);
	expect(
		mcpConfiguredServerSchema.safeParse({ url: "https://example.com/mcp", auth: { type: "bearer" } }).success,
	).toBe(false);
});

it("rejects project provider credentials on load and every persisted mutation", async () => {
	const f = await fixture();
	const cwd = join(f.root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	const server = { url: "https://example.com/mcp", auth: { provider: "fixture" } };
	await writeFile(f.path, JSON.stringify({ mcpServers: { shared: server, good: { command: "node" } } }));
	const path = join(cwd, ".pi", "mcp.json");
	await writeFile(path, JSON.stringify({ mcpServers: { shared: { ...server, url: "https://project.example/mcp" } } }));
	expect((await readPiMcpConfiguration(f.root, null)).loaded.servers).toHaveLength(2);
	const snapshot = await readPiMcpConfiguration(f.root, cwd);
	expect(snapshot.loaded.servers.map((entry) => entry.name)).toEqual(["good"]);
	expect(snapshot.loaded.errors).toEqual([expect.stringContaining("only allowed in the global")]);
	const file = createMcpConfigFile(path, "project");
	const before = await file.read();
	const changes: McpWriteRequest["change"][] = [
		{ kind: "save", server },
		{ kind: "patch", server: { description: "project" }, removeFields: [] },
		{ kind: "toggle", enabled: true },
		{ kind: "reset-enabled" },
	];
	for (const change of changes)
		await expect(file.write({ expectedRevision: before.revision, name: "shared", change }, f.signal)).rejects.toThrow(
			"only allowed in the global",
		);
	expect((await file.read()).revision).toBe(before.revision);
	await file.write(
		{
			expectedRevision: before.revision,
			name: "shared",
			change: { kind: "patch", server: {}, removeFields: ["auth"] },
		},
		f.signal,
	);
	expect((await file.read()).servers.shared).toEqual({ url: "https://project.example/mcp" });
});

it("requires explicit provider credential removal before redirecting an MCP connection", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp", auth: { provider: "fixture" } } } }),
	);
	const input = { expectedRevision: (await f.file.read()).revision, name: "remote" };
	const change = { kind: "patch" as const, server: { url: "https://other.example/mcp" }, removeFields: [] as string[] };
	await expect(f.file.write({ ...input, change }, f.signal)).rejects.toThrow("explicit removeFields for: auth");
	expect((await f.file.read()).revision).toBe(input.expectedRevision);
	await f.file.write({ ...input, change: { ...change, removeFields: ["auth"] } }, f.signal);
	expect((await f.file.read()).servers.remote).toEqual(change.server);
});

it("isolates colliding namespaces and rejects saves that create a collision", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		JSON.stringify({
			mcpServers: { "dev-radius": { command: "node" }, dev_radius: { command: "python" }, valid: { command: "node" } },
		}),
	);
	const snapshot = await readPiMcpConfiguration(f.root, null);
	expect(snapshot.loaded.servers.map((entry) => entry.name)).toEqual(["dev-radius", "valid"]);
	expect(snapshot.loaded.errors).toEqual([expect.stringContaining('conflicts with "dev-radius"')]);
	const before = await f.file.read();
	await expect(
		f.file.write(
			{ expectedRevision: before.revision, name: "dev_radius", change: { kind: "save", server: { command: "node" } } },
			f.signal,
		),
	).rejects.toThrow("conflicts");
	expect((await f.file.read()).revision).toBe(before.revision);
	await f.file.write({ expectedRevision: before.revision, name: "dev_radius", change: { kind: "remove" } }, f.signal);
	expect((await readPiMcpConfiguration(f.root, null)).loaded.errors).toEqual([]);
});

it("preserves formatting, unknown options and unrelated credentials while disabling one service", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		'{\n  "futureOptions": {"futureOption": 42},\n  "mcpServers": {"remote": {"url":"https://example.com/mcp","headers":{"Authorization":"fixture-secret"}}, "local": {"command":"node","customOption":true}}\n}\n',
	);
	const before = await f.file.read();
	await f.file.write(
		{ expectedRevision: before.revision, name: "local", change: { kind: "toggle", enabled: false } },
		f.signal,
	);
	const after = await f.file.read();
	expect(after.servers.remote).toEqual(before.servers.remote);
	expect(after.servers.local).toEqual({ command: "node", customOption: true, enabled: false });
	const source = await readFile(f.path, "utf8");
	expect(source).toContain('"futureOption": 42');
});

it("creates private complete entries and removes only the selected service", async () => {
	const f = await fixture();
	const before = await f.file.read();
	expect(before.exists).toBe(false);
	await expect(
		f.file.write(
			{ expectedRevision: before.revision, name: "remote", change: { kind: "toggle", enabled: false } },
			f.signal,
		),
	).rejects.toThrow();
	await f.file.write(
		{
			expectedRevision: before.revision,
			name: "remote",
			change: { kind: "save", server: { command: "node", enabled: false } },
		},
		f.signal,
	);
	const after = await f.file.read();
	expect(after.servers).toEqual({ remote: { command: "node", enabled: false } });
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
	const results = await Promise.allSettled(
		inputs.map((input) => createMcpConfigFile(f.path, "global").write(input, f.signal)),
	);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(Object.keys((await f.file.read()).servers)).toHaveLength(1);
	await expect(f.file.write(inputs[1]!, f.signal)).rejects.toMatchObject({ code: "MCP_CONFIG_CHANGED" });
});

it("keeps unchanged JSON untouched and reports no mutation for saves, patches and overrides", async () => {
	const f = await fixture();
	const source = '{ "mcpServers": { "local": { "enabled": false, "command": "node" } } }\n';
	await writeFile(f.path, source);
	const before = await f.file.read();
	for (const change of [
		{ kind: "save" as const, server: { command: "node", enabled: false } },
		{ kind: "patch" as const, server: { command: "node" }, removeFields: [] },
		{ kind: "toggle" as const, enabled: false },
	]) {
		await expect(f.file.write({ expectedRevision: before.revision, name: "local", change }, f.signal)).resolves.toBe(
			false,
		);
	}
	for (const kind of ["remove", "reset-enabled"] as const)
		await expect(
			f.file.write({ expectedRevision: before.revision, name: "missing", change: { kind } }, f.signal),
		).resolves.toBe(false);
	expect(await readFile(f.path, "utf8")).toBe(source);
	expect((await f.file.read()).revision).toBe(before.revision);
	await expect(
		f.file.write(
			{ expectedRevision: before.revision, name: "local", change: { kind: "toggle", enabled: true } },
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
				server: { headers: { Accept: "application/json" }, env: { MODE: "test" }, exposure: "direct" as const },
				removeFields: [],
			},
		},
		f.signal,
	);
	expect((await f.file.read()).servers.remote).toEqual({
		...mcpServerSchema.parse(before.servers.remote),
		headers: { Authorization: "fixture-secret", Accept: "application/json" },
		env: { TOKEN: "another-secret", MODE: "test" },
		exposure: "direct" as const,
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

it("requires explicit transport and credential removal before changing connection targets", async () => {
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
	expect(before.servers.local).toEqual({ command: "node", args: ["fixture.js"] });
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
	expect((await f.file.read()).servers.local).toEqual({ url: "https://example.com/mcp" });
});

it("resets the official enable setting while keeping complete connection options", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		'{ "mcpServers": {"partial":{"command":"node","enabled":false,"env":{"MODE":"test"}},"only":{"command":"node","enabled":true}}}\n',
	);
	for (const name of ["partial", "only", "missing"]) {
		const current = await f.file.read();
		await f.file.write({ expectedRevision: current.revision, name, change: { kind: "reset-enabled" } }, f.signal);
	}
	expect((await f.file.read()).servers).toEqual({
		partial: { command: "node", env: { MODE: "test" } },
		only: { command: "node" },
	});
});

it("saves a retained draft against a refreshed revision without replacing another service", async () => {
	const f = await fixture();
	const before = await f.file.read();
	const draft = {
		name: "draft",
		change: { kind: "save" as const, server: { command: "node", exposure: "direct" as const } },
	};
	await writeFile(f.path, '{"mcpServers":{"external":{"url":"https://example.com/mcp"}}}\n');
	await expect(f.file.write({ ...draft, expectedRevision: before.revision }, f.signal)).rejects.toMatchObject({
		code: "MCP_CONFIG_CHANGED",
	});
	const latest = await f.file.read();
	await f.file.write({ ...draft, expectedRevision: latest.revision }, f.signal);
	expect((await f.file.read()).servers).toEqual({ external: latest.servers.external, draft: draft.change.server });
});

it.each([
	"{broken",
	'{"mcpServers":[]}',
	'{ /* comment */ "mcpServers": {} }',
	'{"mcpServers":{},}',
	'\uFEFF{"mcpServers":{}}',
	"",
])("does not overwrite unreadable configuration: %s", async (source) => {
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
});

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

it("reports incompatible entries and preserves valid siblings with complete project precedence", async () => {
	const f = await fixture();
	const cwd = join(f.root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		f.path,
		JSON.stringify({
			autoEnableCodemode: false,
			mcpServers: {
				shared: { url: "https://example.com/mcp", headers: { Authorization: "global-secret" } },
				valid: { command: "node" },
				unsafe: { command: "node" },
				malformed: 3,
				legacy: { command: "node", disabled: true },
				approval: { command: "node", approveTools: true },
			},
		}),
	);
	await writeFile(
		join(cwd, ".pi", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				shared: { command: "python", enabled: false },
				invalid: { enabled: false },
				unsafe: { disabled: true },
			},
		}),
	);
	const global = await readPiMcpConfiguration(f.root, null);
	expect(global.loaded.servers.find((entry) => entry.name === "shared")?.config).toEqual({
		url: "https://example.com/mcp",
		headers: { Authorization: "global-secret" },
	});
	const result = await readPiMcpConfiguration(f.root, cwd);
	expect(result.loaded.servers.map((entry) => entry.name)).toEqual(["valid", "shared"]);
	expect(result.loaded.servers.find((entry) => entry.name === "shared")?.config).toEqual({
		command: "python",
		enabled: false,
	});
	expect(result.loaded.autoEnableCodemode).toBe(false);
	expect(result.loaded.errors).toHaveLength(5);
	expect(result.documents[0]?.servers?.malformed).toBe(3);
	expect(result.loaded.errors.join(" ")).not.toContain("global-secret");
});

it("preserves invalid siblings while repairing one service", async () => {
	const f = await fixture();
	await writeFile(f.path, '{"mcpServers":{"bad":{"command":false},"old":{"command":"node","disabled":true}}}');
	const before = await f.file.read();
	await f.file.write(
		{
			expectedRevision: before.revision,
			name: "old",
			change: { kind: "save", server: { command: "node", enabled: false } },
		},
		f.signal,
	);
	expect((await f.file.read()).servers).toEqual({ bad: { command: false }, old: { command: "node", enabled: false } });
});
