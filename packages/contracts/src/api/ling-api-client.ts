import { modelsProcedures } from "../model-procedures";
import { sessionProcedures } from "../session-procedures";
import type { SessionRef } from "../session-ref";
import type { ShellApi } from "./shell-api";
import { createHostClient } from "./host-procedures";
import type { LingApi } from "./ling-api";
import type { ProcedureTransport } from "../procedure";

interface LingApiClientOptions {
	hostTransport: ProcedureTransport;
	shell: ShellApi;
	env: LingApi["env"];
	ui: LingApi["ui"];
	signal: AbortSignal;
	onBackgroundError(error: unknown): void;
}

export function createLingApiClient(options: LingApiClientOptions): LingApi {
	options.signal.throwIfAborted();
	const host = createHostClient(options.hostTransport);

	// A shell notification can target a session before React mounts. Buffer only the
	// latest navigation intent until the workspace subscriber is ready.
	const activateRequestSubscribers = new Set<(ref: SessionRef) => void>();
	let bufferedActivateRequest: SessionRef | null = null;
	const activateSession = (ref: SessionRef): void => {
		if (options.signal.aborted) return;
		if (activateRequestSubscribers.size === 0) {
			bufferedActivateRequest = ref;
			return;
		}
		bufferedActivateRequest = null;
		for (const callback of activateRequestSubscribers) callback(ref);
	};
	const subscribeActivateRequest = (callback: (ref: SessionRef) => void): (() => void) => {
		options.signal.throwIfAborted();
		activateRequestSubscribers.add(callback);
		if (bufferedActivateRequest !== null) {
			const ref = bufferedActivateRequest;
			bufferedActivateRequest = null;
			callback(ref);
		}
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			activateRequestSubscribers.delete(callback);
		};
	};
	const releases: Array<() => void> = [];
	const releaseSubscriptions = (): void => {
		bufferedActivateRequest = null;
		activateRequestSubscribers.clear();
		const errors: unknown[] = [];
		for (const release of releases.splice(0)) {
			try {
				release();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "Ling client subscription cleanup failed");
	};
	try {
		releases.push(
			options.hostTransport.subscribe<SessionRef>(sessionProcedures.onActivateRequest.channel, activateSession),
		);
		releases.push(
			options.hostTransport.subscribe<string>(modelsProcedures.onOpenExternal.channel, (url) => {
				void options.shell.app.openExternal(url).catch(options.onBackgroundError);
			}),
		);
		releases.push(options.shell.lifecycle.onActivateSession(activateSession));
	} catch (error) {
		try {
			releaseSubscriptions();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Ling client startup and cleanup failed");
		}
		throw error;
	}
	options.signal.addEventListener("abort", releaseSubscriptions, { once: true });

	return {
		editorLanguage: host.editorLanguage,
		voice: host.voice,
		mcp: host.mcp,
		app: {
			...host.app,
			openExternal: options.shell.app.openExternal,
			openPath: options.shell.filesystem.openPath,
			getNotificationPermission: options.shell.app.getNotificationPermission,
			requestNotificationPermission: options.shell.app.requestNotificationPermission,
			getSystemPermission: options.shell.app.getSystemPermission,
			requestSystemPermission: options.shell.app.requestSystemPermission,
			openSystemPermission: options.shell.app.openSystemPermission,
		},
		env: options.env,
		ui: options.ui,
		window: {
			setZoomFactor: options.shell.window.setZoomFactor,
			setLanguage: options.shell.window.setLanguage,
		},
		draft: host.draft,
		userState: host.userState,
		data: host.data,
		diagnostics: host.diagnostics,
		changeReview: host.changeReview,
		git: host.git,
		agent: host.agent,
		usage: host.usage,
		project: {
			...host.project,
			add: async () => {
				const path = await options.shell.filesystem.chooseDirectory();
				if (path === null) return null;
				return host.project.add(path);
			},
			resolveDroppedFileReferences: async (cwd, files) => {
				const filePaths = await options.shell.filesystem.getDroppedFilePaths(files);
				if (filePaths.length !== files.length) throw new Error("Shell returned an incomplete dropped-file list");
				const resolvable = filePaths.filter((path): path is string => path !== null);
				const resolved =
					resolvable.length === 0
						? []
						: await host.project.resolveDroppedFileReferences({ cwd, filePaths: resolvable });
				if (resolved.length !== resolvable.length) throw new Error("Host returned an incomplete dropped-file list");
				let resolvedIndex = 0;
				return filePaths.map((path) => {
					if (path === null) return { status: "unavailable" };
					const result = resolved[resolvedIndex++];
					if (result === undefined) throw new Error("Host omitted a dropped-file result");
					return result;
				});
			},
			revealFileReference: async (request) => {
				const path = await host.project.revealFileReference(request);
				await options.shell.filesystem.revealPath(path);
			},
			revealEntry: async (request) => {
				const path = await host.project.revealEntry(request);
				await options.shell.filesystem.revealPath(path);
			},
		},
		terminal: host.terminal,
		plugins: host.plugins,
		interactions: host.interactions,
		todo: host.todo,
		permissions: host.permissions,
		builtinFeatures: host.builtinFeatures,
		questions: host.questions,
		backgroundTasks: host.backgroundTasks,
		schedules: host.schedules,
		skills: {
			...host.skills,
			reveal: async (request) => {
				const path = await host.skills.reveal(request);
				await options.shell.filesystem.revealPath(path);
			},
			revealResource: async (request) => {
				const path = await host.skills.revealResource(request);
				await options.shell.filesystem.revealPath(path);
			},
			openGlobalDir: async () => {
				const result = await host.skills.openGlobalDir();
				await options.shell.filesystem.openPath(result.dir);
			},
			addPath: async () => {
				const path = await options.shell.filesystem.chooseDirectory();
				if (path === null) return null;
				return host.skills.addPath(path);
			},
		},
		theme: { set: options.shell.window.setTheme },
		skins: {
			...host.skins,
			openDir: async () => {
				const result = await host.skins.openDir();
				await options.shell.filesystem.openPath(result.dir);
				return result;
			},
		},
		updates: options.shell.updates,
		network: host.network,
		piSettings: host.piSettings,
		globalInstructions: {
			...host.globalInstructions,
			reveal: async (kind) => {
				const location = await host.globalInstructions.reveal(kind);
				if (location.exists) await options.shell.filesystem.revealPath(location.filePath);
				else await options.shell.filesystem.openPath(location.dir);
				return location;
			},
			openDir: async () => {
				const result = await host.globalInstructions.openDir();
				await options.shell.filesystem.openPath(result.dir);
				return result;
			},
		},
		models: host.models,
		session: {
			...host.session,
			setViewedSession: async (ref) => {
				// Unmount cleanup can run after pagehide has released the native and Host owners.
				options.signal.throwIfAborted();
				await Promise.all([host.session.setViewedSession(ref), options.shell.lifecycle.setViewedSession(ref)]);
			},
			replayExtensionTerminalInput: options.shell.input.replayExtensionTerminalInput,
			onActivateRequest: subscribeActivateRequest,
		},
	} satisfies LingApi;
}
