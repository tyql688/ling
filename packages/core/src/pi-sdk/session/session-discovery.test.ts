import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import lockfile from "proper-lockfile";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { discoverPiSessions, listPiSessions } from "./session-discovery";
import { piSessionDirectory, piUsageSessionDirectories } from "./session-storage";

it("isolates shared session storage by cwd and retains known sessions after the directory changes", async () => {
	const root = await temporaryDirectory("session-storage");
	const agent = join(root, "agent");
	const cwd = join(root, "first");
	const other = join(root, "second");
	const shared = join(root, "sessions");
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
	try {
		await Promise.all([agent, cwd, other, shared].map((path) => mkdir(path)));
		await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: shared }));
		const timestamp = new Date().toISOString();
		for (const [name, directory] of [
			["one", cwd],
			["two", other],
		] as const) {
			await writeFile(
				join(shared, `${name}.jsonl`),
				[
					JSON.stringify({ type: "session", version: 3, id: name, cwd: directory, timestamp }),
					JSON.stringify({
						type: "message",
						id: "entry",
						parentId: null,
						timestamp,
						message: { role: "user", content: [{ type: "text", text: name }], timestamp: Date.now() },
					}),
				].join("\n") + "\n",
			);
		}
		expect(await piSessionDirectory(cwd)).toBe(shared);
		expect((await piUsageSessionDirectories([cwd, other])).filter((path) => path === shared)).toHaveLength(1);
		expect(await piUsageSessionDirectories([cwd, other])).toContain(join(agent, "sessions"));
		await expect(stat(join(cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(join(other, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await listPiSessions(cwd)).map((session) => session.id)).toEqual(["one"]);
		const first = await discoverPiSessions(cwd, []);
		expect(first).toHaveLength(1);
		const item = first[0]!;
		if (item.kind !== "loaded" || !item.fingerprint) throw new Error("Expected a stable session file");
		await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: join(root, "next") }));
		const retained = await discoverPiSessions(cwd, [{ path: item.path, fingerprint: item.fingerprint }]);
		expect(retained).toEqual([{ kind: "cached", path: item.path, fingerprint: item.fingerprint }]);
		vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "environment"));
		expect(await piUsageSessionDirectories([cwd, other])).toContain(join(root, "environment"));
	} finally {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});

it("waits for a settings lock without blocking its owner from releasing it", async () => {
	const root = await temporaryDirectory("session-storage-lock");
	const path = join(root, "settings.json");
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
	let release: (() => Promise<void>) | undefined;
	try {
		await writeFile(path, JSON.stringify({ sessionDir: join(root, "history") }));
		release = await lockfile.lock(path, { realpath: false });
		const lookup = piSessionDirectory(root);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await release();
		release = undefined;
		expect(await lookup).toBe(join(root, "history"));
	} finally {
		await release?.();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});
