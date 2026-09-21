import { sessionKey } from "@ling/contracts/session-ref";
import { OPEN_SESSION_TABS_MAX_ITEMS, userStateMutationSchema } from "@ling/contracts/user-state";
import { pendingUserMutationsAtom } from "@renderer/lib/user-state/state";
import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { dirtyFileDocumentsAtom, fileDocumentKey } from "@renderer/features/files/file-document-state";
import {
	closeReadingTabsAtom,
	keepReadingTabOpenAtom,
	openReadingTabAtom,
	readingWorkspaceFor,
	READING_WORKSPACE_LIMIT,
	sessionWorkbenchesAtom,
	updateReadingWorkspaceAtom,
	VIEWER_TAB_LIMIT,
	type WorkspaceViewerTab,
} from "./reading-state";
import {
	keepSessionTabOpenAtom,
	moveTab,
	openSessionTabsAtom,
	orderSessionTabs,
	sessionPreviewAtom,
	reconcileTabOrder,
	replaceSessionPreviewAtom,
	tabAfterClosing,
} from "./tab-state";

const alpha = { cwd: "/project", sessionId: "alpha" };
const beta = { cwd: "/project", sessionId: "beta" };
const file = (key: string): WorkspaceViewerTab => ({ kind: "file", key, path: `${key}.md`, cwd: alpha.cwd });

describe("independent conversation and reading groups", () => {
	it("collapses files with the right panel while retaining the workset, and reopens an existing file", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(updateReadingWorkspaceAtom, {
			ref: alpha,
			update: (current) => ({
				...current,
				terminalOpen: true,
				panel: { ...current.panel, open: false, sideMode: "explorer" },
			}),
		});
		const collapsed = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(collapsed).toMatchObject({
			activeKey: "first",
			previewKey: "first",
			terminalOpen: true,
			panel: { open: false },
		});
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		const reopened = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha);
		expect(reopened.tabs).toBe(collapsed.tabs);
		expect(reopened.panel).toMatchObject({ open: true, sideMode: "explorer" });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta).panel.open).toBe(false);
	});
	it("keeps feature reading pages scoped to their session and closes only that page", () => {
		const store = createStore();
		store.set(openSessionTabsAtom, [alpha, beta]);
		const page: WorkspaceViewerTab = { kind: "feature", key: "feature:todo", id: "todo" };
		store.set(openReadingTabAtom, { ref: alpha, tab: page });
		store.set(keepReadingTabOpenAtom, { ref: alpha, key: page.key });
		store.set(openReadingTabAtom, { ref: beta, tab: page });
		store.set(closeReadingTabsAtom, { ref: alpha, keys: [page.key] });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toEqual([]);
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta).activeKey).toBe(page.key);
		expect(store.get(openSessionTabsAtom)).toEqual([alpha, beta]);
	});
	it("closing the final reading tab never selects or closes a conversation", () => {
		const store = createStore();
		store.set(openSessionTabsAtom, [alpha, beta]);
		store.set(replaceSessionPreviewAtom, alpha);
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(closeReadingTabsAtom, { ref: alpha, keys: ["first"] });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).activeKey).toBeNull();
		expect(store.get(openSessionTabsAtom)).toEqual([alpha, beta]);
		expect(store.get(sessionPreviewAtom)).toEqual(alpha);
	});
	it("restores independent preview, active content and layout for sessions in the same project", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(openReadingTabAtom, { ref: beta, tab: file("other") });
		store.set(updateReadingWorkspaceAtom, {
			ref: alpha,
			update: (current) => ({
				...current,
				expanded: true,
				historyExpanded: true,
				terminalOpen: true,
				explorer: { ...current.explorer, selectedPath: "first.md", expanded: new Set(["docs"]) },
				panel: { ...current.panel, sideMode: "review" },
			}),
		});
		store.set(openReadingTabAtom, { ref: beta, tab: file("next") });
		const a = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha),
			b = readingWorkspaceFor(store.get(sessionWorkbenchesAtom), beta);
		expect(a.tabs).toEqual([file("first")]);
		expect(a).toMatchObject({
			expanded: true,
			historyExpanded: true,
			terminalOpen: true,
			activeKey: "first",
			previewKey: "first",
		});
		expect(b).toMatchObject({
			tabs: [file("next")],
			activeKey: "next",
			previewKey: "next",
			expanded: false,
			terminalOpen: false,
		});
		expect(b.explorer.expanded.size).toBe(0);
		expect(b.panel.sideMode).toBeNull();
	});
	it("keeps promoted and dirty previews, and replaces only the next clean preview", () => {
		const store = createStore();
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(keepReadingTabOpenAtom, { ref: alpha, key: "first" });
		store.set(openReadingTabAtom, { ref: alpha, tab: file("dirty") });
		store.set(dirtyFileDocumentsAtom, new Set([fileDocumentKey(alpha.cwd, "dirty.md")]));
		store.set(openReadingTabAtom, { ref: alpha, tab: file("replace") });
		store.set(openReadingTabAtom, { ref: alpha, tab: file("last") });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs.map((tab) => tab.key)).toEqual([
			"first",
			"dirty",
			"last",
		]);
		store.set(closeReadingTabsAtom, { ref: alpha, keys: ["first", "last"] });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).activeKey).toBe("dirty");
	});
	it("keeps source conversation preview promotion out of the reading preview slot", () => {
		const store = createStore();
		store.set(replaceSessionPreviewAtom, alpha);
		store.set(keepSessionTabOpenAtom, alpha);
		store.set(openReadingTabAtom, { ref: alpha, tab: file("first") });
		store.set(replaceSessionPreviewAtom, beta);
		expect(store.get(sessionPreviewAtom)).toEqual(beta);
		expect(store.get(openSessionTabsAtom)).toEqual([alpha]);
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).previewKey).toBe("first");
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
		for (let i = 0; i < VIEWER_TAB_LIMIT + 2; i++)
			store.set(openReadingTabAtom, { ref: alpha, tab: file(String(i)), keepOpen: true });
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs).toHaveLength(VIEWER_TAB_LIMIT);
		expect(readingWorkspaceFor(store.get(sessionWorkbenchesAtom), alpha).tabs[0]?.key).toBe("dirty");
	});
	it("chooses a neighbor only within the supplied group", () => {
		expect(tabAfterClosing([{ key: "a" }, { key: "b" }, { key: "c" }], "b", new Set(["b"]))).toBe("c");
		expect(tabAfterClosing([{ key: "file" }], "file", new Set(["file"]))).toBeNull();
	});
});

describe("workspace tab order", () => {
	it("removes closed entries without displacing retained tabs and appends each new tab once", () => {
		expect(reconcileTabOrder(["file", "closed", "alpha", "alpha"], ["alpha", "beta", "file", "beta"])).toEqual([
			"file",
			"alpha",
			"beta",
		]);
	});

	it("keeps a promoted preview in its dragged position when persisting session-only order", () => {
		const keys = [sessionKey(alpha), "file", sessionKey(beta)];
		const moved = moveTab(keys, sessionKey(beta), sessionKey(alpha), "before");
		expect(moved).toEqual([sessionKey(beta), sessionKey(alpha), "file"]);
		expect(orderSessionTabs([alpha, beta], moved)).toEqual([beta, alpha]);
		expect(moveTab(moved, sessionKey(beta), "file", "after")).toEqual([sessionKey(alpha), "file", sessionKey(beta)]);
		expect(moveTab(keys, "closed", "file", "before")).toEqual(keys);
	});

	it("bounds both saved membership and order when promoting beyond the tab budget", () => {
		const store = createStore();
		const refs = Array.from({ length: OPEN_SESSION_TABS_MAX_ITEMS + 1 }, (_, index) => ({
			cwd: alpha.cwd,
			sessionId: String(index),
		}));
		store.set(openSessionTabsAtom, refs);
		expect(store.get(openSessionTabsAtom)).toEqual(refs.slice(1));
		const mutations = store.get(pendingUserMutationsAtom);
		expect(mutations).toHaveLength(1);
		expect(userStateMutationSchema.safeParse(mutations[0]?.mutation).success).toBe(true);
	});
});
