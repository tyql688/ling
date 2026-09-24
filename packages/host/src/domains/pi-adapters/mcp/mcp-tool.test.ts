import { afterEach, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "../../../../../../test/temporary-directory";
import { createMcpConfigFile } from "@ling/core/pi-sdk/mcp/mcp-config";
import type { McpOverview } from "@ling/contracts/mcp";
import { createBuiltinFeatures } from "../../companions/builtin-features";
import { changeBuiltinFeature } from "../../companions/builtin-feature-change";
import { createResourceReloadCoordinator } from "../../resources/resource-reload";
import { createMcpSettings } from "./mcp-settings";
import { createMcpTool } from "./mcp-tool";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await temporaryDirectory("mcp-tool");
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const ref = { cwd: root, sessionId: "session" };
	const path = join(root, "mcp.json");
	const file = createMcpConfigFile(path);
	const signal = new AbortController().signal;
	const features = createBuiltinFeatures(root);
	let trusted = true;
	let managed = true;
	let reloadFailure = false;
	const reloaded: (readonly string[] | undefined)[] = [];
	const changed: boolean[] = [];
	const sessions: (readonly string[] | undefined)[] = [];
	const configurationChanges: number[] = [];
	const resources = createResourceReloadCoordinator({
		reloadProjectSettings: async (cwds) => {
			reloaded.push(cwds);
			if (reloadFailure) throw new Error("fixture reload failed");
		},
		reloadSessionResources: async (cwds) => {
			if (cwds?.length !== 0) sessions.push(cwds);
			return { revision: 1, reloaded: 0, deferred: 1, failed: [], failedOmitted: 0 };
		},
	});
	cleanups.push(resources.dispose);
	const settings = createMcpSettings({
		onChanged: () => configurationChanges.push(configurationChanges.length + 1),
		assertProject: async (cwd) => {
			expect(cwd).toBe(root);
			if (!trusted) throw new Error("Project is not trusted");
		},
		resources,
		piWorker: {
			readMcp: async (cwd): Promise<McpOverview> => {
				expect(cwd).toBe(root);
				return {
					documents: [{ ...(await file.read()), path, target: "project", scope: "project", error: null }],
					effective: [],
				};
			},
			writeMcp: async (input, writeSignal) => {
				expect(input.cwd).toBe(root);
				const changed = await file.write(input, writeSignal ?? signal);
				return { changed, reloadProjects: changed ? [root] : [] };
			},
		},
	});
	cleanups.push(settings.dispose);
	const tool = createMcpTool({
		settings,
		features,
		resources,
		requireManagedSession: (value) => {
			expect(value).toEqual(ref);
			if (!managed) throw new Error("Session closed");
		},
		setFeature: (enabled, expectedRevision, signal) =>
			changeBuiltinFeature(
				{
					features,
					resources,
					onChanged: (_id, value) => {
						changed.push(value);
					},
				},
				{ id: "mcp", enabled, expectedRevision },
				signal,
			),
	});
	return {
		path,
		ref,
		file,
		features,
		settings,
		signal,
		changed,
		reloaded,
		sessions,
		configurationChanges,
		run: async (request: unknown) => JSON.parse(await tool.run({ ref, request }, signal)),
		setTrusted: (value: boolean) => {
			trusted = value;
		},
		closeSession: () => {
			managed = false;
		},
		failReload: () => {
			reloadFailure = true;
		},
	};
}

it("allows configuration while off, keeps values out of inventory and reports deferred reloads", async () => {
	const f = await fixture();
	await writeFile(
		f.path,
		JSON.stringify({
			mcpServers: {
				remote: {
					url: "https://example.com?token=fixture-url-secret",
					headers: { Authorization: "fixture-header-secret" },
				},
			},
		}),
	);
	const read = await f.run({ action: "read" });
	expect(read.feature.enabled).toBe(false);
	expect(JSON.stringify(read)).not.toContain("fixture-url-secret");
	expect(JSON.stringify(read)).not.toContain("fixture-header-secret");
	const result = await f.run({
		action: "configure",
		target: "project",
		name: "remote",
		expectedRevision: read.documents[0].revision,
		server: { approveTools: true },
	});
	expect(result).toMatchObject({
		saved: true,
		feature: { enabled: false },
		reload: { sessions: { deferred: 1 } },
	});
	expect((await f.file.read()).servers.remote?.headers?.Authorization).toBe("fixture-header-secret");
	expect(f.changed).toEqual([]);
	expect(f.reloaded).toEqual([]);
	expect(f.sessions).toEqual([[f.ref.cwd]]);
	expect(f.configurationChanges).toHaveLength(1);
	const saved = await f.file.read();
	await f.run({
		action: "configure",
		target: "project",
		name: "remote",
		expectedRevision: saved.revision,
		server: { approveTools: true },
	});
	expect(f.reloaded).toEqual([]);
	expect(f.sessions).toEqual([[f.ref.cwd]]);
	expect(f.configurationChanges).toHaveLength(1);
});

it("changes the master switch explicitly, checks revisions, and retains partial reload failure", async () => {
	const f = await fixture();
	const before = await f.run({ action: "read" });
	f.failReload();
	const enabled = await f.run({
		action: "set_feature_enabled",
		enabled: true,
		expectedFeatureRevision: before.feature.revision,
	});
	expect(enabled).toMatchObject({
		saved: true,
		feature: { enabled: true },
		reload: { projectError: "fixture reload failed" },
	});
	expect(f.changed).toEqual([true]);
	await expect(
		f.run({ action: "set_feature_enabled", enabled: false, expectedFeatureRevision: before.feature.revision }),
	).rejects.toMatchObject({
		errors: [
			expect.objectContaining({ message: "Feature settings changed. Refresh before saving." }),
			expect.objectContaining({ code: "PI_RESOURCE_RELOAD_INCOMPLETE" }),
		],
	});
	expect((await f.features.read()).enabled.mcp).toBe(true);
	await f.run({ action: "set_feature_enabled", enabled: false, expectedFeatureRevision: enabled.feature.revision });
	expect((await f.features.read()).enabled.mcp).toBe(false);
});

it("preserves other project fields when resetting a service switch and rejects a stale remove", async () => {
	const f = await fixture();
	await writeFile(f.path, '{"mcpServers":{"inherited":{"env":{"MODE":"test"}}}}');
	const request = { target: "project", name: "inherited" };
	const original = (await f.file.read()).revision;
	await f.run({ ...request, action: "set_server_enabled", enabled: false, expectedRevision: original });
	expect((await f.file.read()).servers.inherited?.disabled).toBe(true);
	await expect(f.run({ ...request, action: "remove", expectedRevision: original })).rejects.toMatchObject({
		code: "MCP_CONFIG_CHANGED",
	});
	await f.run({ ...request, action: "reset_server_enabled", expectedRevision: (await f.file.read()).revision });
	expect((await f.file.read()).servers.inherited).toEqual({ env: { MODE: "test" } });
});

it("rejects foreign project arguments, whole config documents, untrusted projects and closed sessions", async () => {
	const f = await fixture();
	await expect(f.run({ action: "read", cwd: "/other" })).rejects.toThrow();
	await expect(
		f.run({
			action: "configure",
			target: "project",
			name: "bad",
			expectedRevision: (await f.file.read()).revision,
			server: { mcpServers: {} },
		}),
	).rejects.toThrow("one MCP service");
	f.setTrusted(false);
	await expect(f.run({ action: "set_feature_enabled", enabled: true, expectedFeatureRevision: 0 })).rejects.toThrow(
		"not trusted",
	);
	f.setTrusted(true);
	f.closeSession();
	await expect(f.run({ action: "read" })).rejects.toThrow("Session closed");
	expect((await f.features.read()).enabled.mcp).toBe(false);
	expect(f.reloaded).toEqual([]);
});
