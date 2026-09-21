import { execFileSync } from "node:child_process";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import type { PiWorkerClient } from "../../workers/pi/pi-worker-client";
import { createHostDatabase } from "../../storage/database";
import { createHostEventBus } from "../../transport/event-bus";
import { getGitStatus } from "../git/git-service";
import { listWorktrees, listWorktreeBranchOptions } from "../git/git-mutations";
import { createResourceReloadCoordinator } from "../resources/resource-reload";
import { createAppSettingsStore } from "../settings/app-settings";
import { createMetadataCleanupHost } from "./metadata-cleanup";
import { createMetadataCleanupRetryStore } from "./metadata-cleanup-retry-store";
import { createProjectDomain } from "./project-handlers";
import { createProjectLifecycle } from "./project-lifecycle";
import { createProjectMentionCache } from "./project-mention-cache";
import { createProjectStore } from "./project-store";

async function createFixture() {
	const root = await realpath(await temporaryDirectory("project-availability"));
	const userDataDir = join(root, "userdata");
	const database = createHostDatabase(userDataDir);
	const store = createProjectStore({ userDataDir, database });
	const settings = createAppSettingsStore({ userDataDir, database });
	const mentionCache = createProjectMentionCache();
	const openPaths = new Set<string>();
	const piWorker = {
		listOpenProjectPaths: () => [...openPaths],
		withProject: async <T>(cwd: string, operation: (cwd: string) => Promise<T>) => {
			if (!openPaths.has(cwd)) throw new Error(`Unknown open project: ${cwd}`);
			return operation(cwd);
		},
		inspectProject: vi.fn(async (cwd: string) => ({ cwd, diagnostics: [] })),
		openProject: async (path: string) => {
			const cwd = await realpath(path);
			openPaths.add(cwd);
			return { cwd, diagnostics: [] };
		},
		closeProject: vi.fn(async (cwd: string, drain: (cwd: string) => Promise<void>) => {
			await drain(cwd);
			openPaths.delete(cwd);
		}),
		prepareShutdown: async () => {},
	} satisfies Parameters<typeof createProjectLifecycle>[0]["piWorker"];
	const removeSessionFromCatalog = vi.fn(async () => {});
	const metadataCleanup = createMetadataCleanupHost({
		retries: createMetadataCleanupRetryStore({ userDataDir, database }),
		removeSessionFromCatalog,
		deleteChangeReviewSessionState: async () => {},
		releaseChangeReviewProject: async () => {},
	});
	const projects = createProjectLifecycle({
		projectStore: store,
		piWorker,
		mentionCache,
		metadataCleanup,
		runBoundedGitWriteAtRoot: async (_cwd, operation) => operation(new AbortController().signal),
		sessions: {
			closeSessionsForProject: async () => [],
			cancelProjectSessionOperations: () => {},
			cancelAllSessionOperations: () => {},
			unsubscribeSessionEvents: async () => {},
			restoreSessionRuntimesAndEvents: async () => {},
		},
	});
	const resources = createResourceReloadCoordinator({
		reloadProjectSettings: async () => {},
		reloadSessionResources: async () => {
			throw new Error("Resource reload is outside project inspection");
		},
	});
	const events = createHostEventBus();
	const domain = createProjectDomain({
		piWorker: piWorker as unknown as PiWorkerClient,
		resources,
		projectOperations: { resolveKnownOpenProjectPath: (cwd) => cwd, withKnownOpenProject: piWorker.withProject },
		events,
		projectsRestored: Promise.resolve(),
		projects,
		settings,
		mentionCache,
	});
	const context = () => ({ clientId: "test", product: "web" as const, signal: new AbortController().signal });
	return {
		root,
		projects,
		piWorker,
		database,
		store,
		events,
		removeSessionFromCatalog,
		list: () => domain.handlers["project:list"]!(context()),
		add: (cwd: string) => domain.handlers["project:add"]!(context(), cwd),
		remove: (cwd: string) => domain.handlers["project:remove"]!(context(), cwd),
		async open(name: string) {
			const cwd = join(root, name);
			await mkdir(cwd);
			return projects.openProjectAndPersist(cwd);
		},
		async dispose() {
			await domain.dispose?.();
			await projects.closeAllProjectsForShutdown();
			await resources.dispose();
			await metadataCleanup.shutdownMetadataCleanupRetries();
			await mentionCache.dispose();
			await settings.dispose();
			database.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

it("keeps a deleted directory in a complete project list and probes Git again when it returns", async () => {
	const fixture = await createFixture();
	try {
		const original = await fixture.open("project");
		expect(original.availability).toBe("ready");
		await rm(original.cwd, { recursive: true });
		const missing = { ...original, availability: "missing", meta: { kind: "primary", branchName: null } };
		await expect(fixture.projects.toProjectInfo(original.cwd)).resolves.toEqual(missing);
		await expect(fixture.list()).resolves.toEqual({ status: "complete", projects: [missing] });
		await expect(getGitStatus(original.cwd)).rejects.toThrow();

		await mkdir(original.cwd);
		execFileSync("git", ["init", "-b", "restored", original.cwd], { stdio: "ignore" });
		await expect(fixture.projects.toProjectInfo(original.cwd)).resolves.toMatchObject({
			availability: "ready",
			meta: { kind: "primary", branchName: "restored" },
		});
	} finally {
		await fixture.dispose();
	}
});

it("refuses to add a project directory that does not exist", async () => {
	const fixture = await createFixture();
	try {
		await expect(fixture.add(join(fixture.root, "never-created"))).rejects.toMatchObject({
			code: "PROJECT_DIRECTORY_MISSING",
		});
		await expect(fixture.list()).resolves.toEqual({ status: "complete", projects: [] });
	} finally {
		await fixture.dispose();
	}
});

it("reports real inspection failures without dropping healthy or missing projects", async () => {
	const fixture = await createFixture();
	try {
		const healthy = await fixture.open("healthy");
		const missing = await fixture.open("missing");
		const unreadable = await fixture.open("unreadable");
		await rm(missing.cwd, { recursive: true });
		await rm(unreadable.cwd, { recursive: true });
		await symlink(unreadable.cwd, unreadable.cwd, "dir");
		await expect(fixture.projects.toProjectInfo(unreadable.cwd)).rejects.toMatchObject({ code: "ELOOP" });
		await expect(fixture.list()).resolves.toMatchObject({
			status: "partial",
			projects: [healthy, { cwd: missing.cwd, availability: "missing" }],
			failureCount: 1,
			firstFailure: { cwd: unreadable.cwd, message: expect.any(String) },
		});
	} finally {
		await fixture.dispose();
	}
});

it("ignores prunable worktree registrations without hiding failures in live checkouts", async () => {
	const fixture = await createFixture();
	try {
		const { cwd } = await fixture.open("repository");
		const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
		git("init", "-b", "main");
		git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
		const removed = join(fixture.root, "deleted-release");
		const live = join(fixture.root, "live-checkout");
		git("worktree", "add", "-b", "release", removed);
		git("worktree", "add", "-b", "feature", live);
		await rm(removed, { recursive: true });
		expect(git("worktree", "list", "--porcelain")).toContain("prunable");
		await expect(fixture.list()).resolves.toMatchObject({
			status: "complete",
			projects: [{ cwd, availability: "ready", meta: { kind: "primary", branchName: "main" } }],
		});
		expect((await listWorktrees(cwd)).map((worktree) => worktree.canonicalPath)).toEqual([cwd, live]);
		expect(await listWorktreeBranchOptions(cwd)).toContainEqual({ name: "release", checkedOutPath: null });
		// A locked checkout may be on an offline disk; it is not a stale, prunable registration.
		git("worktree", "lock", live);
		await rm(live, { recursive: true });
		await expect(listWorktrees(cwd)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fixture.dispose();
	}
});

it.each([false, true])(
	"persists missing-project removal and retains the catalog when teardown fails: %s",
	async (failClose) => {
		const fixture = await createFixture();
		try {
			const { cwd } = await fixture.open("removed");
			fixture.database.run(
				"INSERT INTO session_catalog(cwd,session_id,session_file_path) VALUES(?,?,?)",
				cwd,
				"saved-session",
				join(fixture.root, "saved-session.jsonl"),
			);
			await rm(cwd, { recursive: true });
			if (failClose) fixture.piWorker.closeProject.mockRejectedValueOnce(new Error("Runtime close failed"));
			await expect(fixture.projects.removeProjectAndPersist(cwd)).resolves.toMatchObject({
				status: failClose ? "removed-with-warning" : "removed",
				cwd,
			});
			await fixture.projects.persistOpenProjects();
			expect(fixture.store.readOpenProjectPaths()).toEqual([]);
			expect(fixture.database.get("SELECT is_open FROM projects WHERE cwd=?", cwd)).toEqual({ is_open: 0 });
			expect(fixture.database.get("SELECT session_id FROM session_catalog WHERE cwd=?", cwd)).toEqual({
				session_id: "saved-session",
			});
			expect(fixture.removeSessionFromCatalog).not.toHaveBeenCalled();
		} finally {
			await fixture.dispose();
		}
	},
);

it("tells every connected client to refetch when a project is added or removed", async () => {
	const fixture = await createFixture();
	try {
		const changes: number[] = [];
		fixture.events.subscribe((event) => {
			if (event.channel === "project:changed") changes.push(event.sequence);
		});
		const cwd = join(fixture.root, "shared");
		await mkdir(cwd);
		await fixture.add(cwd);
		expect(changes).toHaveLength(1);
		await fixture.remove(cwd);
		expect(changes).toHaveLength(2);
	} finally {
		await fixture.dispose();
	}
});
