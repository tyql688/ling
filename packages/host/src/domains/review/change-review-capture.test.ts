import { execFileSync } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { configureHostRuntimePaths } from "../../runtime/runtime-paths";
import { createHostDatabase } from "../../storage/database";
import { createChangeReviewCaptureOwner } from "./change-review-capture";
import { createChangeReviewQueryOwner } from "./change-review-query";
import { createChangeReviewRuntimeOwner } from "./change-review-runtime";
import { createChangeReviewStore } from "./change-review-store";
import { createProjectFileWatchers } from "./project-file-watcher";

let root: string;
beforeAll(async () => {
	root = await realpath(await temporaryDirectory("change-capture"));
	configureHostRuntimePaths({
		appRoot: root,
		builtinSkillsDir: join(root, "skills"),
		logsDir: join(root, "logs"),
		resourcesDir: root,
		hostEntriesDir: root,
		userDataDir: join(root, "userdata"),
		dataHome: join(root, "ling-home"),
		packaged: false,
	});
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
	return execFileSync(
		"git",
		["-c", "user.name=Capture Test", "-c", "user.email=capture@example.invalid", "-c", "commit.gpgSign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
}

async function fixture(name: string) {
	const directory = join(root, name);
	const cwd = join(directory, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "Before\n");
	const ref = { cwd, sessionId: name };
	const database = createHostDatabase(join(directory, "data"));
	const store = createChangeReviewStore({ userDataDir: join(directory, "data"), database });
	const watchers = createProjectFileWatchers();
	const runtime = createChangeReviewRuntimeOwner({
		store,
		watchers,
		withProject: async (path, operation) => {
			expect(path).toBe(cwd);
			return operation(cwd);
		},
	});
	const capture = createChangeReviewCaptureOwner(runtime, store.persist);
	const query = createChangeReviewQueryOwner(runtime, store);
	return {
		cwd,
		ref,
		store,
		runtime,
		query,
		capture,
		async dispose() {
			try {
				await runtime.shutdown();
			} finally {
				await watchers.dispose();
				database.dispose();
				await rm(directory, { recursive: true, force: true });
			}
		},
	};
}

it("recovers the original turn after an embedded repository temporarily has no checked-out commit", async () => {
	const f = await fixture("clone-recovery");
	const context = { userMessageEntryId: "request" };
	try {
		await f.capture.turnLifecycleHost.start(f.ref, 1, context);
		const clone = join(f.cwd, "reference");
		await mkdir(clone);
		git(clone, "init", "--quiet");
		expect((await f.query.getSnapshot(f.ref)).tracking.turn).toEqual({
			status: "partial",
			reason: "shadowCaptureFailed",
		});

		await writeFile(join(clone, "README.md"), "Reference\n");
		git(clone, "add", ".");
		git(clone, "commit", "--quiet", "-m", "reference");
		await writeFile(join(f.cwd, "README.md"), "After\n");
		await writeFile(join(f.cwd, ".gitignore"), "reference/\n");
		git(f.cwd, "init", "--quiet");
		git(f.cwd, "add", ".");
		git(f.cwd, "commit", "--quiet", "-m", "initial project");
		await f.capture.turnLifecycleHost.finish(f.ref, 2, { files: [], failureCode: null }, context);

		const snapshot = await f.query.getSnapshot(f.ref);
		expect(snapshot.tracking).toEqual({ turn: { status: "complete" }, session: { status: "complete" } });
		expect(snapshot.scopes.workspace.files).toEqual([]);
		const stored = await f.store.loadState(f.ref);
		expect(stored?.turns[0]?.files.map((file) => file.path)).toEqual([".gitignore", "README.md"]);
		expect(stored?.turns[0]?.files.find((file) => file.path === "README.md")?.diff).toContain("-Before\n+After");
		expect(stored?.turns[0]).toMatchObject({
			beforeHeadSha: null,
			userMessageEntryId: "request",
			tracking: { status: "complete" },
		});
	} finally {
		await f.dispose();
	}
});

it("keeps a failed final capture partial and never replaces a missing initial baseline", async () => {
	const f = await fixture("capture-still-fails");
	const context = { userMessageEntryId: "request" };
	const fallback = { files: [{ path: "observed.md", status: "added" as const, diff: "+Observed" }], failureCode: null };
	try {
		await f.capture.turnLifecycleHost.start(f.ref, 1, context);
		const clone = join(f.cwd, "reference");
		await mkdir(clone);
		git(clone, "init", "--quiet");
		await f.query.getSnapshot(f.ref);
		await f.capture.turnLifecycleHost.finish(f.ref, 2, fallback, context);
		expect((await f.store.loadState(f.ref))?.turns[0]).toMatchObject({
			tracking: { status: "partial", reason: "shadowCaptureFailed" },
			files: fallback.files,
		});

		await f.capture.turnLifecycleHost.start(f.ref, 3, context);
		await rm(clone, { recursive: true });
		await f.capture.turnLifecycleHost.finish(f.ref, 4, fallback, context);
		expect((await f.store.loadState(f.ref))?.turns[1]).toMatchObject({
			tracking: { status: "partial", reason: "shadowCaptureFailed" },
			files: fallback.files,
		});
	} finally {
		await f.dispose();
	}
});
