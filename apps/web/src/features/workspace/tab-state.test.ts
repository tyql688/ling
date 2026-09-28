import { activeSessionRefAtom } from "@renderer/features/sessions/state/session";
import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { dirtyFileDocumentsAtom, fileDocumentKey } from "@renderer/features/files/file-document-state";
import {
	closeReadingTabsAtom,
	openReadingTabAtom,
	readingWorkspaceFor,
	READING_WORKSPACE_LIMIT,
	sessionWorkbenchesAtom,
	updateReadingWorkspaceAtom,
	VIEWER_TAB_LIMIT,
	withFeatureTab,
	withOpenColumn,
	type WorkspaceViewerTab,
} from "./reading-state";
import { moveTab, tabAfterClosing } from "./tab-state";

const alpha = { cwd: "/project", sessionId: "alpha" };
const beta = { cwd: "/project", sessionId: "beta" };
const file = (key: string): WorkspaceViewerTab => ({ kind: "file", key, path: `${key}.md`, cwd: alpha.cwd });

describe("session-owned reading tabs", () => {
	it("collapses files with the right panel while retaining the workset, and reopens an existing file", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(updateReadingWorkspaceAtom, {
			ref: alpha,
			update: (current) => ({
				...current,
				historyExpanded: true,
				panel: { ...current.panel, open: false, treeOpen: true },
			}),
		});
		const collapsed = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(collapsed).toMatchObject({
			activeKey: "first",
			historyExpanded: true,
			panel: { open: false },
		});
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		const reopened = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(reopened.tabs).toBe(collapsed.tabs);
		expect(reopened.panel).toMatchObject({ open: true, treeOpen: true });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta).panel.open).toBe(false);
	});
	it("keeps feature reading pages scoped to their session and closes only that page", () => {
		const store = createStore();
		const page: WorkspaceViewerTab = { kind: "feature", key: "feature:todo", id: "todo" };
		store.set(openReadingTabAtom, { ref: alpha, tab: page });
		store.set(openReadingTabAtom, { ref: beta, tab: page });
		store.set(closeReadingTabsAtom, { ref: alpha, keys: [page.key] });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toEqual([]);
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta).activeKey).toBe(page.key);
	});
	it("closing the final reading tab never selects or closes a conversation", () => {
		const store = createStore();
		store.set(activeSessionRefAtom, alpha);
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(closeReadingTabsAtom, { ref: alpha, keys: ["first"] });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).activeKey).toBeNull();
		expect(store.get(activeSessionRefAtom)).toEqual(alpha);
	});
	it("restores independent files, active content and layout for sessions in the same project", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(openReadingTabAtom, { ref: beta, tab: file("other") });
		store.set(updateReadingWorkspaceAtom, {
			ref: alpha,
			update: (current) => ({
				...current,
				expanded: true,
				historyExpanded: true,
				explorer: { ...current.explorer, selectedPath: "first.md", expanded: new Set(["docs"]) },
				panel: { ...current.panel, treeOpen: true },
			}),
		});
		store.set(openReadingTabAtom, { ref: beta, tab: file("next") });
		const a = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha),
			b = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta);
		expect(a.tabs).toEqual([file("first")]);
		expect(a).toMatchObject({
			expanded: true,
			historyExpanded: true,
			activeKey: "first",
		});
		expect(b).toMatchObject({
			tabs: [file("other"), file("next")],
			activeKey: "next",
			expanded: false,
		});
		expect(b.explorer.expanded.size).toBe(0);
		expect(b.panel.treeOpen).toBe(false);
	});
	it("opens each tool tab once without replacing open files", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("retained") });
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (current) => withFeatureTab(current, "changes") });
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (current) => withFeatureTab(current, "changes") });
		const state = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(state.tabs.map((tab) => tab.key)).toEqual(["retained", "feature:changes"]);
		expect(state).toMatchObject({ activeKey: "feature:changes" });
		store.set(openReadingTabAtom, { ref: alpha, tab: file("next") });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs.map((tab) => tab.key)).toEqual([
			"retained",
			"feature:changes",
			"next",
		]);
	});
	it("retains the selected skill resource in its session when switching tool pages", () => {
		const store = createStore();
		store.set(updateReadingWorkspaceAtom, {
			ref: alpha,
			update: (current) =>
				withFeatureTab(
					{
						...current,
						skill: {
							skill: {
								name: "example",
								description: "Example",
								filePath: "/project/.agents/skills/example/SKILL.md",
								source: "auto",
								scope: "project",
								origin: "top-level",
								projectCwd: alpha.cwd,
								builtin: false,
								enabled: true,
								disableModelInvocation: false,
							},
							resourcePath: "references/example.md",
							scrollTop: 480,
						},
					},
					"skills",
				),
		});
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (current) => withFeatureTab(current, "changes") });
		store.set(updateReadingWorkspaceAtom, { ref: beta, update: (current) => withFeatureTab(current, "skills") });
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (current) => withFeatureTab(current, "skills") });
		const state = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(state.tabs.map((tab) => tab.key)).toEqual(["feature:skills", "feature:changes"]);
		expect(state.skill).toMatchObject({ resourcePath: "references/example.md", scrollTop: 480 });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta).skill).toBeNull();
	});
	it("lands an empty right column on the new tab page and closes the column with its last tab", () => {
		const store = createStore();
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: withOpenColumn });
		const opened = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(opened.tabs).toEqual([{ key: opened.activeKey, kind: "feature", id: "new-tab" }]);
		expect(opened.panel.open).toBe(true);
		store.set(closeReadingTabsAtom, { ref: alpha, keys: [opened.activeKey!] });
		const closed = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(closed.tabs).toEqual([]);
		expect(closed.panel.open).toBe(false);
	});
	it.each(["skills", "changes", "terminal", "files"] as const)(
		"creates distinct launchers and replaces only the active one with %s",
		(id) => {
			let state = withOpenColumn(readingWorkspaceFor(new Map(), alpha));
			const firstLauncher = state.activeKey;
			state = withFeatureTab(state, "new-tab");
			const secondLauncher = state.activeKey;
			expect(secondLauncher).not.toBe(firstLauncher);
			expect(state.tabs).toHaveLength(2);
			state = withFeatureTab(state, id);
			expect(state.tabs).toEqual([
				{ kind: "feature", key: firstLauncher, id: "new-tab" },
				{ kind: "feature", key: `feature:${id}`, id },
			]);
			state = withFeatureTab({ ...state, activeKey: firstLauncher }, id);
			expect(state.tabs).toEqual([{ kind: "feature", key: `feature:${id}`, id }]);
			expect(state.activeKey).toBe(`feature:${id}`);
		},
	);
	it("replaces the file launcher with the first file, then retains additional files", () => {
		const store = createStore();
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: withOpenColumn });
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (state) => withFeatureTab(state, "files") });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toEqual([
			{ kind: "feature", key: "feature:files", id: "files" },
		]);
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toEqual([file("first")]);
		store.set(openReadingTabAtom, { ref: alpha, tab: file("second") });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toEqual([file("first"), file("second")]);
	});
	it.each(["new-tab", "files"] as const)("consumes %s when reopening a file without losing its view", (id) => {
		const store = createStore();
		const original = {
			kind: "file" as const,
			key: "first",
			cwd: alpha.cwd,
			path: "first.md",
			view: { mode: "source" as const, scrollTop: 480 },
		};
		store.set(openReadingTabAtom, { ref: alpha, tab: original });
		store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (state) => withFeatureTab(state, id) });
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		const state = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(state.tabs).toEqual([original]);
		expect(state.activeKey).toBe(original.key);
	});
	it("keeps every opened file and chooses a neighbor when the active file closes", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(openReadingTabAtom, { ref: alpha, tab: file("dirty") });
		store.set(dirtyFileDocumentsAtom, new Set([fileDocumentKey(alpha.cwd, "dirty.md")]));
		store.set(openReadingTabAtom, { ref: alpha, tab: file("replace") });
		store.set(openReadingTabAtom, { ref: alpha, tab: file("last") });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs.map((tab) => tab.key)).toEqual([
			"first",
			"dirty",
			"replace",
			"last",
		]);
		store.set(closeReadingTabsAtom, { ref: alpha, keys: ["first", "replace", "last"] });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).activeKey).toBe("dirty");
	});
	it("does not resurrect removed session navigation from a late view callback", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(sessionWorkbenchesAtom, new Map());
		store.set(updateReadingWorkspaceAtom, {
			ref: alpha,
			existingOnly: true,
			update: (current) => ({ ...current, expanded: true }),
		});
		store.set(closeReadingTabsAtom, { ref: alpha, keys: ["first"] });
		expect(store.get(sessionWorkbenchesAtom).size).toBe(0);
	});
	it("bounds clean worksets and tabs while retaining unsaved documents", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("dirty") });
		store.set(dirtyFileDocumentsAtom, new Set([fileDocumentKey(alpha.cwd, "dirty.md")]));
		for (let i = 0; i < READING_WORKSPACE_LIMIT + 2; i++)
			store.set(openReadingTabAtom, { ref: { ...alpha, sessionId: String(i) }, tab: file(String(i)) });
		expect(store.get(sessionWorkbenchesAtom).size).toBe(READING_WORKSPACE_LIMIT);
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toEqual([file("dirty")]);
		for (let i = 0; i < VIEWER_TAB_LIMIT + 2; i++) store.set(openReadingTabAtom, { ref: alpha, tab: file(String(i)) });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toHaveLength(VIEWER_TAB_LIMIT);
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs[0]?.key).toBe("dirty");
		for (let i = 0; i < VIEWER_TAB_LIMIT + 2; i++)
			store.set(updateReadingWorkspaceAtom, { ref: alpha, update: (state) => withFeatureTab(state, "new-tab") });
		const withLaunchers = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(withLaunchers.tabs).toHaveLength(VIEWER_TAB_LIMIT);
		expect(withLaunchers.tabs[0]?.key).toBe("dirty");
		expect(withLaunchers.tabs.at(-1)?.key).toBe(withLaunchers.activeKey);
	});
	it("chooses a neighbor only within the supplied group", () => {
		expect(tabAfterClosing([{ key: "a" }, { key: "b" }, { key: "c" }], "b", new Set(["b"]))).toBe("c");
		expect(tabAfterClosing([{ key: "file" }], "file", new Set(["file"]))).toBeNull();
	});
});

describe("reading tab order", () => {
	it("moves retained tabs before or after a neighbor and ignores unavailable targets", () => {
		const keys = ["first", "second", "third"];
		const moved = moveTab(keys, "third", "first", "before");
		expect(moved).toEqual(["third", "first", "second"]);
		expect(moveTab(moved, "third", "second", "after")).toEqual(keys);
		expect(moveTab(keys, "closed", "second", "before")).toEqual(keys);
	});
});
