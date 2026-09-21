import { terminalFontFamilyAtom, terminalFontSizeAtom, terminalTypography } from "./terminal-preferences";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useAtomValue } from "jotai";
import type { createTerminalEmulator } from "./terminal-emulator";
import type { TerminalEvent, TerminalOutputChunk, TerminalProfile, TerminalSnapshot } from "@ling/contracts/terminal";
import { APPEARANCE_CHANGED_EVENT } from "@renderer/lib/appearance/skins/apply-skin";
import { useCallback, useEffect, useRef, useState, useMemo, createContext, useContext } from "react";
import {
	assignTerminalToPane,
	createTerminalPane,
	findPaneForTerminal,
	findTerminalPane,
	removeTerminalPane,
	splitTerminalPane,
	terminalPaneLeaves,
	type TerminalSplitDirection,
	updateTerminalSplitRatio,
} from "./terminal-layout";
import {
	beginTerminalRuntimeResync,
	cancelTerminalRuntimeResync,
	completeTerminalRuntimeResync,
	createTerminalRuntime,
	disposeTerminalRuntime,
	failTerminalRuntimeResync,
	fitTerminalRuntime,
	hydrateTerminalRuntime,
	mountTerminalRuntime,
	queueTerminalOutput,
	replaceTerminalRuntimeReplay,
	resetTerminalRuntimeResyncFailure,
	terminalRef,
	type TerminalRuntime,
	updateTerminalRuntimeTheme,
} from "./terminal-runtime";
import {
	type ProjectTerminalWorkspace,
	reconcileProjectTerminalWorkspace,
	rememberProjectTerminalWorkspace,
	restoreProjectTerminalWorkspace,
} from "./terminal-workspace-state";

/** Cap on split-pane leaf nodes per project terminal group; beyond it readability and layout costs climb steeply. */
const MAX_SPLIT_PANES = 4;
/** Automatic recovery is bounded; a later explicit focus starts a fresh attempt window. */
const MAX_TERMINAL_RESYNC_ATTEMPTS = 3;
const TERMINAL_RESYNC_RETRY_DELAYS_MS = [50, 250] as const;

export interface TerminalController {
	revision: number;
	loading: boolean;
	profiles: TerminalProfile[];
	suggestedProfileId: string | null;
	configuredProfileId: string | null;
	getWorkspace(cwd: string): ProjectTerminalWorkspace | null;
	getRuntime(terminalId: string): TerminalRuntime | null;
	ensureProjectTerminal(cwd: string): Promise<string>;
	createTerminal(cwd: string, profileId?: string | null): Promise<string>;
	splitTerminal(cwd: string, direction: TerminalSplitDirection, profileId?: string | null): Promise<string>;
	selectTerminal(cwd: string, terminalId: string): void;
	focusPane(cwd: string, paneId: string): void;
	closeTerminal(terminalId: string): Promise<void>;
	mountTerminal(terminalId: string, container: HTMLElement): () => void;
	fitTerminal(terminalId: string): void;
	focusTerminal(terminalId: string): void;
	searchTerminal(terminalId: string, query: string, direction: "next" | "previous", incremental: boolean): boolean;
	clearTerminalSearch(terminalId: string): void;
	canSplit(cwd: string): boolean;
	setSplitRatio(cwd: string, splitId: string, ratio: number): void;
}

export function useTerminalController(onError: (error: unknown) => void): TerminalController {
	const hostTerminalApi = useDomainApi("terminal");
	const hostAppApi = useDomainApi("app");

	const family = useAtomValue(terminalFontFamilyAtom);
	const fontSize = useAtomValue(terminalFontSizeAtom);
	const typography = useMemo(() => terminalTypography(family, fontSize), [family, fontSize]);
	const typographyRef = useRef(typography);
	typographyRef.current = typography;
	const runtimesRef = useRef(new Map<string, TerminalRuntime>());
	const workspacesRef = useRef(new Map<string, ProjectTerminalWorkspace>());
	const ensureRequestsRef = useRef(new Map<string, Promise<string>>());
	const resyncRequestsRef = useRef(new Map<string, Promise<void>>());
	const requestRuntimeResyncRef = useRef<(runtime: TerminalRuntime) => void>(() => undefined);
	const activeRef = useRef(true);
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const [revision, setRevision] = useState(0);
	const [loading, setLoading] = useState(true);
	const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
	const [suggestedProfileId, setSuggestedProfileId] = useState<string | null>(null);
	const [configuredProfileId, setConfiguredProfileId] = useState<string | null>(null);
	useEffect(() => {
		for (const runtime of runtimesRef.current.values()) {
			runtime.xterm.options.fontFamily = typography.fontFamily;
			runtime.xterm.options.fontSize = typography.fontSize;
			if (runtime.opened) fitTerminalRuntime(runtime, (error) => onErrorRef.current(error));
		}
	}, [typography]);

	const bump = useCallback(() => {
		if (activeRef.current) setRevision((current) => current + 1);
	}, []);

	const requestRuntimeResync = useCallback(
		(runtime: TerminalRuntime): void => {
			if (
				!activeRef.current ||
				runtime.disposed ||
				runtime.resyncFailed ||
				runtime.resyncRetryTimer !== null ||
				runtimesRef.current.get(runtime.snapshot.id) !== runtime ||
				resyncRequestsRef.current.has(runtime.snapshot.id)
			) {
				return;
			}
			if (!beginTerminalRuntimeResync(runtime)) return;
			let retry = false;
			let retryCause: unknown = null;
			const operation: Promise<void> = hostTerminalApi
				.attach(terminalRef(runtime.snapshot))
				.then((attachment) => {
					if (!activeRef.current || runtime.disposed || runtimesRef.current.get(runtime.snapshot.id) !== runtime) {
						return;
					}
					const state = replaceTerminalRuntimeReplay(runtime, attachment, (error) => onErrorRef.current(error));
					if (state === "ready") completeTerminalRuntimeResync(runtime);
					else retry = state !== "failed";
					bump();
				})
				.catch((error: unknown) => {
					if (runtimesRef.current.get(runtime.snapshot.id) === runtime && !runtime.disposed) {
						cancelTerminalRuntimeResync(runtime);
						retry = true;
						retryCause = error;
					}
				})
				.finally(() => {
					if (resyncRequestsRef.current.get(runtime.snapshot.id) === operation) {
						resyncRequestsRef.current.delete(runtime.snapshot.id);
					}
					if (!retry || !activeRef.current || runtime.disposed) return;
					if (runtimesRef.current.get(runtime.snapshot.id) !== runtime) return;
					if (runtime.resyncAttempts >= MAX_TERMINAL_RESYNC_ATTEMPTS) {
						failTerminalRuntimeResync(runtime);
						const message = `Terminal output could not be synchronized after ${MAX_TERMINAL_RESYNC_ATTEMPTS} attempts. Focus the terminal to retry, or close it and open a new terminal.`;
						onErrorRef.current(retryCause === null ? new Error(message) : new Error(message, { cause: retryCause }));
						return;
					}
					const delay = TERMINAL_RESYNC_RETRY_DELAYS_MS[runtime.resyncAttempts - 1] ?? 250;
					runtime.resyncRetryTimer = window.setTimeout(() => {
						runtime.resyncRetryTimer = null;
						requestRuntimeResyncRef.current(runtime);
					}, delay);
				});
			resyncRequestsRef.current.set(runtime.snapshot.id, operation);
		},
		[hostTerminalApi, bump],
	);
	requestRuntimeResyncRef.current = requestRuntimeResync;

	const ingestRuntimeOutput = useCallback(
		(runtime: TerminalRuntime, chunk: TerminalOutputChunk): void => {
			const state = queueTerminalOutput(runtime, chunk, (error) => onErrorRef.current(error));
			if (state === "gap" || state === "resync") requestRuntimeResync(runtime);
		},
		[requestRuntimeResync],
	);

	const ensureWorkspace = useCallback((cwd: string): ProjectTerminalWorkspace => {
		const existing = workspacesRef.current.get(cwd);
		if (existing) return existing;
		const availableTerminalIds = [...runtimesRef.current.values()]
			.filter((runtime) => runtime.snapshot.cwd === cwd)
			.map((runtime) => runtime.snapshot.id);
		const workspace = reconcileProjectTerminalWorkspace(restoreProjectTerminalWorkspace(cwd), availableTerminalIds);
		workspacesRef.current.set(cwd, workspace);
		return workspace;
	}, []);

	const ensureRuntime = useCallback(
		(snapshot: TerminalSnapshot, createEmulator: typeof createTerminalEmulator): TerminalRuntime => {
			const existing = runtimesRef.current.get(snapshot.id);
			if (existing) {
				existing.snapshot = snapshot;
				return existing;
			}
			const runtime = createTerminalRuntime(
				createEmulator,
				hostTerminalApi,
				hostAppApi.openExternal,
				snapshot,
				(error) => onErrorRef.current(error),
				bump,
				typographyRef.current,
			);
			runtimesRef.current.set(snapshot.id, runtime);
			return runtime;
		},
		[bump, hostAppApi.openExternal, hostTerminalApi],
	);

	const removeLocalTerminal = useCallback(
		(terminalId: string): void => {
			const runtime = runtimesRef.current.get(terminalId);
			if (runtime) {
				disposeTerminalRuntime(runtime, false, (error) => onErrorRef.current(error));
				runtimesRef.current.delete(terminalId);
			}
			const workspace =
				(runtime && workspacesRef.current.get(runtime.snapshot.cwd)) ??
				[...workspacesRef.current.values()].find((candidate) => candidate.terminalIds.includes(terminalId));
			if (workspace) {
				workspace.terminalIds = workspace.terminalIds.filter((id) => id !== terminalId);
				workspace.root = workspace.root ? removeTerminalPane(workspace.root, terminalId) : null;
				if (workspace.root === null && workspace.terminalIds.length > 0) {
					workspace.root = createTerminalPane(workspace.terminalIds[0] as string);
				}
				const leaves = workspace.root ? terminalPaneLeaves(workspace.root) : [];
				if (!leaves.some((leaf) => leaf.paneId === workspace.activePaneId)) {
					workspace.activePaneId = leaves[0]?.paneId ?? null;
				}
				rememberProjectTerminalWorkspace(workspace);
				if (workspace.terminalIds.length === 0) workspacesRef.current.delete(workspace.cwd);
			}
			bump();
		},
		[bump],
	);

	useEffect(() => {
		let cancelled = false;
		activeRef.current = true;
		const unsubscribe = hostTerminalApi.onEvent((event: TerminalEvent) => {
			if (event.type === "removed") {
				const runtime = runtimesRef.current.get(event.ref.terminalId);
				if (runtime?.snapshot.generation === event.ref.generation) removeLocalTerminal(event.ref.terminalId);
				return;
			}
			if (event.type === "exit") {
				const runtime = runtimesRef.current.get(event.snapshot.id);
				if (!runtime || runtime.snapshot.generation !== event.snapshot.generation) return;
				runtime.snapshot = event.snapshot;
				bump();
				return;
			}
			const runtime = runtimesRef.current.get(event.chunk.terminalId);
			if (runtime) {
				ingestRuntimeOutput(runtime, event.chunk);
			}
			// Unknown runtimes are intentionally not buffered here. `attach()` replays
			// authoritative output after list/create has installed the runtime, while
			// leaving these chunks unacked keeps host backpressure intact.
		});

		void Promise.all([hostTerminalApi.list(), hostTerminalApi.listProfiles()])
			.then(async ([snapshots, profileSnapshot]) => {
				if (cancelled) return;
				setProfiles(profileSnapshot.profiles);
				setSuggestedProfileId(profileSnapshot.suggestedProfileId);
				setConfiguredProfileId(profileSnapshot.configuredProfileId);
				if (snapshots.length > 0) {
					const { createTerminalEmulator } = await import("./terminal-emulator");
					if (cancelled) return;
					for (const snapshot of snapshots) ensureRuntime(snapshot, createTerminalEmulator);
				}
				for (const snapshot of snapshots) {
					const runtime = runtimesRef.current.get(snapshot.id);
					if (!runtime) throw new Error("Terminal runtime initialization failed.");
					const workspace = ensureWorkspace(snapshot.cwd);
					if (!workspace.terminalIds.includes(snapshot.id)) workspace.terminalIds.push(snapshot.id);
					void hostTerminalApi
						.attach(terminalRef(snapshot))
						.then((attachment) => {
							if (!cancelled) {
								const state = hydrateTerminalRuntime(runtime, attachment, (error) => onErrorRef.current(error));
								if (state === "gap" || state === "resync") requestRuntimeResync(runtime);
								bump();
							}
						})
						.catch(() => {
							if (!cancelled) requestRuntimeResync(runtime);
						});
				}
				for (const [cwd, workspace] of workspacesRef.current) {
					const availableTerminalIds = workspace.terminalIds.filter(
						(terminalId) => runtimesRef.current.get(terminalId)?.snapshot.cwd === cwd,
					);
					const reconciled = reconcileProjectTerminalWorkspace(workspace, availableTerminalIds);
					workspacesRef.current.set(cwd, reconciled);
					rememberProjectTerminalWorkspace(reconciled);
				}
				bump();
			})
			.catch((error: unknown) => {
				if (!cancelled) onErrorRef.current(error);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		const updateRuntimeThemes = () => {
			for (const runtime of runtimesRef.current.values()) updateTerminalRuntimeTheme(runtime);
		};
		window.addEventListener(APPEARANCE_CHANGED_EVENT, updateRuntimeThemes);

		return () => {
			cancelled = true;
			activeRef.current = false;
			unsubscribe();
			window.removeEventListener(APPEARANCE_CHANGED_EVENT, updateRuntimeThemes);
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			for (const workspace of workspacesRef.current.values()) rememberProjectTerminalWorkspace(workspace);
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			for (const runtime of runtimesRef.current.values()) {
				disposeTerminalRuntime(runtime, true, (error) => onErrorRef.current(error));
			}
			runtimesRef.current.clear();
			workspacesRef.current.clear();
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			ensureRequestsRef.current.clear();
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			resyncRequestsRef.current.clear();
		};
	}, [
		hostTerminalApi,
		bump,
		ensureRuntime,
		ensureWorkspace,
		ingestRuntimeOutput,
		removeLocalTerminal,
		requestRuntimeResync,
	]);

	const attachRuntime = useCallback(
		async (runtime: TerminalRuntime): Promise<void> => {
			const attachment = await hostTerminalApi.attach(terminalRef(runtime.snapshot));
			const state = hydrateTerminalRuntime(runtime, attachment, (error) => onErrorRef.current(error));
			if (state === "gap" || state === "resync") requestRuntimeResync(runtime);
			bump();
		},
		[hostTerminalApi, bump, requestRuntimeResync],
	);

	const initializeCreatedRuntime = useCallback(
		async (snapshot: TerminalSnapshot): Promise<TerminalRuntime> => {
			let runtime: TerminalRuntime | null = null;
			try {
				const { createTerminalEmulator } = await import("./terminal-emulator");
				if (!activeRef.current) throw new Error("Terminal creation was cancelled because the workspace closed.");
				runtime = ensureRuntime(snapshot, createTerminalEmulator);
				await attachRuntime(runtime);
				if (!activeRef.current) throw new Error("Terminal creation was cancelled because the workspace closed.");
				return runtime;
			} catch (error) {
				let closeError: unknown = null;
				try {
					await hostTerminalApi.close(terminalRef(snapshot));
				} catch (cause) {
					closeError = cause;
				} finally {
					if (runtime) removeLocalTerminal(snapshot.id);
				}
				if (closeError !== null) {
					throw new AggregateError([error, closeError], "The terminal could not be attached or cleaned up.");
				}
				throw error;
			}
		},
		[hostTerminalApi, attachRuntime, ensureRuntime, removeLocalTerminal],
	);

	const createTerminal = useCallback(
		async (cwd: string, profileId?: string | null): Promise<string> => {
			const workspace = ensureWorkspace(cwd);
			const activeLeaf =
				workspace.root && workspace.activePaneId ? findTerminalPane(workspace.root, workspace.activePaneId) : null;
			const activeRuntime = activeLeaf ? runtimesRef.current.get(activeLeaf.terminalId) : null;
			const snapshot = await hostTerminalApi.create({
				cwd,
				cols: Math.max(2, activeRuntime?.xterm.cols ?? 100),
				rows: Math.max(1, activeRuntime?.xterm.rows ?? 24),
				...(profileId === undefined ? {} : { profileId }),
			});
			await initializeCreatedRuntime(snapshot);
			if (!workspace.terminalIds.includes(snapshot.id)) workspace.terminalIds.push(snapshot.id);
			if (workspace.root === null || workspace.activePaneId === null) {
				const pane = createTerminalPane(snapshot.id);
				workspace.root = pane;
				workspace.activePaneId = pane.paneId;
			} else {
				workspace.root = assignTerminalToPane(workspace.root, workspace.activePaneId, snapshot.id);
			}
			rememberProjectTerminalWorkspace(workspace);
			bump();
			return snapshot.id;
		},
		[hostTerminalApi, bump, ensureWorkspace, initializeCreatedRuntime],
	);

	const ensureProjectTerminal = useCallback(
		(cwd: string): Promise<string> => {
			const workspace = workspacesRef.current.get(cwd);
			const existing = workspace?.terminalIds[0];
			if (existing) return Promise.resolve(existing);
			const inFlight = ensureRequestsRef.current.get(cwd);
			if (inFlight) return inFlight;
			const request = createTerminal(cwd).finally(() => ensureRequestsRef.current.delete(cwd));
			ensureRequestsRef.current.set(cwd, request);
			return request;
		},
		[createTerminal],
	);

	const splitTerminal = useCallback(
		async (cwd: string, direction: TerminalSplitDirection, profileId?: string | null): Promise<string> => {
			const workspace = ensureWorkspace(cwd);
			if (workspace.root === null || workspace.activePaneId === null) return createTerminal(cwd, profileId);
			if (terminalPaneLeaves(workspace.root).length >= MAX_SPLIT_PANES) {
				throw new Error(`A terminal group supports at most ${MAX_SPLIT_PANES} panes.`);
			}
			const activeLeaf = findTerminalPane(workspace.root, workspace.activePaneId);
			const activeRuntime = activeLeaf ? runtimesRef.current.get(activeLeaf.terminalId) : null;
			const snapshot = await hostTerminalApi.create({
				cwd,
				cols: Math.max(2, activeRuntime?.xterm.cols ?? 80),
				rows: Math.max(1, activeRuntime?.xterm.rows ?? 24),
				...(profileId === undefined ? {} : { profileId }),
			});
			await initializeCreatedRuntime(snapshot);
			workspace.terminalIds.push(snapshot.id);
			const split = splitTerminalPane(workspace.root, workspace.activePaneId, snapshot.id, direction);
			workspace.root = split.root;
			workspace.activePaneId = split.paneId;
			rememberProjectTerminalWorkspace(workspace);
			bump();
			return snapshot.id;
		},
		[hostTerminalApi, bump, createTerminal, ensureWorkspace, initializeCreatedRuntime],
	);

	const selectTerminal = useCallback(
		(cwd: string, terminalId: string): void => {
			const workspace = workspacesRef.current.get(cwd);
			if (!workspace?.root || !workspace.terminalIds.includes(terminalId)) return;
			const visible = findPaneForTerminal(workspace.root, terminalId);
			if (visible) {
				workspace.activePaneId = visible.paneId;
			} else if (workspace.activePaneId) {
				workspace.root = assignTerminalToPane(workspace.root, workspace.activePaneId, terminalId);
			}
			rememberProjectTerminalWorkspace(workspace);
			bump();
		},
		[bump],
	);

	const focusPane = useCallback(
		(cwd: string, paneId: string): void => {
			const workspace = workspacesRef.current.get(cwd);
			if (!workspace?.root || !findTerminalPane(workspace.root, paneId)) return;
			workspace.activePaneId = paneId;
			rememberProjectTerminalWorkspace(workspace);
			bump();
		},
		[bump],
	);

	const closeTerminal = useCallback(
		async (terminalId: string): Promise<void> => {
			const runtime = runtimesRef.current.get(terminalId);
			if (!runtime) return;
			await hostTerminalApi.close(terminalRef(runtime.snapshot));
			removeLocalTerminal(terminalId);
		},
		[hostTerminalApi, removeLocalTerminal],
	);

	const mountTerminal = useCallback((terminalId: string, container: HTMLElement): (() => void) => {
		const runtime = runtimesRef.current.get(terminalId);
		if (!runtime) return () => undefined;
		return mountTerminalRuntime(runtime, container, (error) => onErrorRef.current(error));
	}, []);

	const fitTerminal = useCallback((terminalId: string): void => {
		const runtime = runtimesRef.current.get(terminalId);
		if (runtime) fitTerminalRuntime(runtime, (error) => onErrorRef.current(error));
	}, []);

	const focusTerminal = useCallback(
		(terminalId: string): void => {
			const runtime = runtimesRef.current.get(terminalId);
			if (runtime && resetTerminalRuntimeResyncFailure(runtime)) requestRuntimeResync(runtime);
			if (runtime?.opened && runtime.xterm.element?.isConnected) runtime.xterm.focus();
		},
		[requestRuntimeResync],
	);

	const searchTerminal = useCallback(
		(terminalId: string, query: string, direction: "next" | "previous", incremental: boolean): boolean => {
			const runtime = runtimesRef.current.get(terminalId);
			if (!runtime || query.length === 0) return false;
			const options = { incremental };
			return direction === "previous"
				? runtime.searchAddon.findPrevious(query, options)
				: runtime.searchAddon.findNext(query, options);
		},
		[],
	);

	const clearTerminalSearch = useCallback((terminalId: string): void => {
		const runtime = runtimesRef.current.get(terminalId);
		runtime?.searchAddon.clearDecorations();
		runtime?.xterm.clearSelection();
	}, []);

	const getWorkspace = useCallback<TerminalController["getWorkspace"]>(
		(cwd) => workspacesRef.current.get(cwd) ?? null,
		[],
	);
	const getRuntime = useCallback<TerminalController["getRuntime"]>(
		(terminalId) => runtimesRef.current.get(terminalId) ?? null,
		[],
	);
	const canSplit = useCallback<TerminalController["canSplit"]>((cwd) => {
		const root = workspacesRef.current.get(cwd)?.root;
		return root === null || root === undefined || terminalPaneLeaves(root).length < MAX_SPLIT_PANES;
	}, []);
	const setSplitRatio = useCallback<TerminalController["setSplitRatio"]>(
		(cwd, splitId, ratio) => {
			const workspace = workspacesRef.current.get(cwd);
			if (!workspace?.root) return;
			workspace.root = updateTerminalSplitRatio(workspace.root, splitId, ratio);
			rememberProjectTerminalWorkspace(workspace);
			bump();
		},
		[bump],
	);
	return useMemo(
		() => ({
			revision,
			loading,
			profiles,
			suggestedProfileId,
			configuredProfileId,
			getWorkspace,
			getRuntime,
			ensureProjectTerminal,
			createTerminal,
			splitTerminal,
			selectTerminal,
			focusPane,
			closeTerminal,
			mountTerminal,
			fitTerminal,
			focusTerminal,
			searchTerminal,
			clearTerminalSearch,
			canSplit,
			setSplitRatio,
		}),
		[
			revision,
			loading,
			profiles,
			suggestedProfileId,
			configuredProfileId,
			getWorkspace,
			getRuntime,
			ensureProjectTerminal,
			createTerminal,
			splitTerminal,
			selectTerminal,
			focusPane,
			closeTerminal,
			mountTerminal,
			fitTerminal,
			focusTerminal,
			searchTerminal,
			clearTerminalSearch,
			canSplit,
			setSplitRatio,
		],
	);
}

export const TerminalContext = createContext<TerminalController | null>(null);
export function useTerminals() {
	const value = useContext(TerminalContext);
	if (!value) throw new Error("Terminal provider is not mounted");
	return value;
}
