import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";

interface ProjectSessionOperation {
	cwd: string;
	promise: Promise<unknown>;
}

export function createSessionLifecycleOperations() {
	const projectSessionOperations = new Set<ProjectSessionOperation>();
	const runtimeCreationOperations = new Set<Promise<unknown>>();
	const openingSessions = new Map<string, Promise<void>>();
	const closingSessions = new Map<string, Promise<void>>();
	const deletingSessions = new Map<string, Promise<void>>();

	function trackProjectSessionOperation<T>(cwd: string, operation: Promise<T>): Promise<T> {
		const entry = { cwd, promise: operation as Promise<unknown> } satisfies ProjectSessionOperation;
		const tracked = operation.finally(() => projectSessionOperations.delete(entry));
		entry.promise = tracked;
		projectSessionOperations.add(entry);
		return tracked;
	}

	function pendingProjectSessionOperations(cwd: string): Promise<unknown>[] {
		return [...projectSessionOperations].filter((entry) => entry.cwd === cwd).map((entry) => entry.promise);
	}

	function hasProjectSessionOperations(cwd: string): boolean {
		return [...projectSessionOperations].some((entry) => entry.cwd === cwd);
	}

	function trackSessionRuntimeCreation<T>(operation: Promise<T>): Promise<T> {
		const tracked: Promise<T> = operation.finally(() => runtimeCreationOperations.delete(tracked));
		runtimeCreationOperations.add(tracked);
		return tracked;
	}

	function pendingSessionRuntimeCreations(): Promise<unknown>[] {
		return [...runtimeCreationOperations];
	}

	function registerSessionOperation(
		operations: Map<string, Promise<void>>,
		ref: SessionRef,
		operation: Promise<void>,
	): Promise<void> {
		const key = sessionKey(ref);
		const tracked: Promise<void> = operation.finally(() => {
			if (operations.get(key) === tracked) operations.delete(key);
		});
		operations.set(key, tracked);
		return tracked;
	}

	function getOpeningSession(ref: SessionRef): Promise<void> | undefined {
		return openingSessions.get(sessionKey(ref));
	}

	function registerOpeningSession(ref: SessionRef, operation: Promise<void>): Promise<void> {
		return registerSessionOperation(openingSessions, ref, operation);
	}

	function getClosingSession(ref: SessionRef): Promise<void> | undefined {
		return closingSessions.get(sessionKey(ref));
	}

	function registerClosingSession(ref: SessionRef, operation: Promise<void>): Promise<void> {
		return registerSessionOperation(closingSessions, ref, operation);
	}

	function getDeletingSession(ref: SessionRef): Promise<void> | undefined {
		return deletingSessions.get(sessionKey(ref));
	}

	function registerDeletingSession(ref: SessionRef, operation: Promise<void>): Promise<void> {
		return registerSessionOperation(deletingSessions, ref, operation);
	}

	function hasSessionLifecycleOperation(ref: SessionRef): boolean {
		const key = sessionKey(ref);
		return openingSessions.has(key) || closingSessions.has(key) || deletingSessions.has(key);
	}

	async function drain(): Promise<void> {
		const failures: unknown[] = [];
		while (projectSessionOperations.size > 0 || runtimeCreationOperations.size > 0) {
			const results = await Promise.allSettled(
				[...projectSessionOperations].map((entry) => entry.promise).concat([...runtimeCreationOperations]),
			);
			for (const result of results) if (result.status === "rejected") failures.push(result.reason);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Session lifecycle operations failed while draining");
	}
	return {
		trackProjectSessionOperation,
		pendingProjectSessionOperations,
		hasProjectSessionOperations,
		trackSessionRuntimeCreation,
		pendingSessionRuntimeCreations,
		getOpeningSession,
		registerOpeningSession,
		getClosingSession,
		registerClosingSession,
		getDeletingSession,
		registerDeletingSession,
		hasSessionLifecycleOperation,
		drain,
	};
}

export type SessionLifecycleOperations = ReturnType<typeof createSessionLifecycleOperations>;
