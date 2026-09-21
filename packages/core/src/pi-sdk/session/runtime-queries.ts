import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import {
	type ImageAttachment,
	type ModelState,
	type SessionCommandCatalog,
	sessionImageMimeTypeSchema,
	type SessionQueue,
} from "@ling/contracts/session";
import type { SessionRuntimeSnapshot, SessionRuntimeStateSnapshot } from "@ling/core/pi-protocol/runtime-types";
import type { PiAgentSessionRuntime } from "../types";
import {
	type PiRuntimeProjection,
	projectPiRuntimeCommandCatalog,
	projectPiRuntimeSnapshot,
	projectPiRuntimeStateSnapshot,
} from "./runtime-projection";
interface RuntimeQueryOwner {
	runtime(): PiAgentSessionRuntime;
	diagnostics: readonly PiDiagnostic[];
	queue(): SessionQueue;
	assertReadable(): void;
	markdownWidth(): number;
	isBusy(): boolean;
	projections: Pick<PiRuntimeProjection, "projectPiRuntimeModelState" | "projectPiRuntimeSummary">;
}
interface PiRuntimeQueries {
	getSessionName(): string | undefined;
	getBranchLeafEntryId(): Promise<string | null>;
	getFirstUserMessageText(): Promise<string | null>;
	readImagePart(entryId: string, index: number): Promise<ImageAttachment | null>;
	getModelState(): Promise<ModelState>;
	listCommands(): SessionCommandCatalog;
	getStateSnapshot(): Promise<SessionRuntimeStateSnapshot>;
	getStateSnapshotAtBoundary<Boundary>(
		captureBoundary: (snapshot: SessionRuntimeStateSnapshot) => Boundary,
	): Promise<{ snapshot: SessionRuntimeStateSnapshot; boundary: Boundary }>;
	getSnapshot(): Promise<SessionRuntimeSnapshot>;
	getSnapshotAtBoundary<Boundary>(
		captureBoundary: (snapshot: SessionRuntimeSnapshot) => Boundary,
	): Promise<{ snapshot: SessionRuntimeSnapshot; boundary: Boundary }>;
	summarize(createdAt: number, placeholderTitle: string): ReturnType<PiRuntimeProjection["projectPiRuntimeSummary"]>;
}
export function createPiRuntimeQueries(owner: RuntimeQueryOwner): PiRuntimeQueries {
	return {
		getSessionName() {
			return getSessionName(owner);
		},
		getBranchLeafEntryId() {
			return getBranchLeafEntryId(owner);
		},
		getFirstUserMessageText() {
			return getFirstUserMessageText(owner);
		},
		readImagePart(entryId: string, index: number) {
			return readImagePart(owner, entryId, index);
		},
		getModelState() {
			return getModelState(owner);
		},
		listCommands() {
			return listCommands(owner);
		},
		getStateSnapshot() {
			return getStateSnapshot(owner);
		},
		getStateSnapshotAtBoundary<Boundary>(captureBoundary: (snapshot: SessionRuntimeStateSnapshot) => Boundary) {
			return getStateSnapshotAtBoundary(owner, captureBoundary);
		},
		getSnapshot() {
			return getSnapshot(owner);
		},
		getSnapshotAtBoundary<Boundary>(captureBoundary: (snapshot: SessionRuntimeSnapshot) => Boundary) {
			return getSnapshotAtBoundary(owner, captureBoundary);
		},
		summarize(createdAt: number, placeholderTitle: string) {
			return summarize(owner, createdAt, placeholderTitle);
		},
	};
}

function getSessionName(owner: RuntimeQueryOwner): string | undefined {
	owner.assertReadable();
	return owner.runtime().session.sessionManager.getSessionName();
}

async function getBranchLeafEntryId(owner: RuntimeQueryOwner): Promise<string | null> {
	owner.assertReadable();
	return owner.runtime().session.sessionManager.getLeafId();
}

async function getFirstUserMessageText(owner: RuntimeQueryOwner): Promise<string | null> {
	owner.assertReadable();
	const [first] = owner.runtime().session.getUserMessagesForForking();
	return first?.text ?? null;
}

async function readImagePart(
	owner: RuntimeQueryOwner,
	entryId: string,
	index: number,
): Promise<ImageAttachment | null> {
	owner.assertReadable();
	const entry = owner.runtime().session.sessionManager.getEntry(entryId);
	// A custom message injected by an extension carries its content directly, and it may hold
	// images just as a model message does.
	const content: unknown =
		entry?.type === "message"
			? (entry.message as { content?: unknown }).content
			: entry?.type === "custom_message"
				? entry.content
				: null;
	if (!Array.isArray(content)) return null;
	const part: unknown = content[index];
	if (typeof part !== "object" || part === null) return null;
	const candidate = part as { type?: unknown; data?: unknown; mimeType?: unknown; mediaType?: unknown };
	if (candidate.type !== "image" || typeof candidate.data !== "string") return null;
	const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : candidate.mediaType;
	const parsedMimeType = sessionImageMimeTypeSchema.safeParse(mimeType);
	if (!parsedMimeType.success) return null;
	return { type: "image", data: candidate.data, mimeType: parsedMimeType.data };
}

async function getModelState(owner: RuntimeQueryOwner): Promise<ModelState> {
	owner.assertReadable();
	return owner.projections.projectPiRuntimeModelState(owner.runtime().session);
}

function listCommands(owner: RuntimeQueryOwner): SessionCommandCatalog {
	owner.assertReadable();
	return projectPiRuntimeCommandCatalog(owner.runtime().session);
}

async function getStateSnapshot(owner: RuntimeQueryOwner): Promise<SessionRuntimeStateSnapshot> {
	owner.assertReadable();
	return projectPiRuntimeStateSnapshot(owner.runtime(), owner.diagnostics, owner.isBusy(), owner.queue());
}

async function getStateSnapshotAtBoundary<Boundary>(
	owner: RuntimeQueryOwner,
	captureBoundary: (snapshot: SessionRuntimeStateSnapshot) => Boundary,
): Promise<{ snapshot: SessionRuntimeStateSnapshot; boundary: Boundary }> {
	const snapshot = await getStateSnapshot(owner);
	return { snapshot, boundary: captureBoundary(snapshot) };
}

async function getSnapshot(owner: RuntimeQueryOwner): Promise<SessionRuntimeSnapshot> {
	owner.assertReadable();
	return projectPiRuntimeSnapshot(
		owner.runtime(),
		owner.diagnostics,
		owner.isBusy(),
		owner.queue(),
		owner.markdownWidth(),
	);
}

async function getSnapshotAtBoundary<Boundary>(
	owner: RuntimeQueryOwner,
	captureBoundary: (snapshot: SessionRuntimeSnapshot) => Boundary,
): Promise<{ snapshot: SessionRuntimeSnapshot; boundary: Boundary }> {
	const snapshot = await getSnapshot(owner);
	return { snapshot, boundary: captureBoundary(snapshot) };
}

function summarize(owner: RuntimeQueryOwner, createdAt: number, placeholderTitle: string) {
	owner.assertReadable();
	return owner.projections.projectPiRuntimeSummary(
		owner.runtime().session,
		createdAt,
		placeholderTitle,
		owner.markdownWidth(),
	);
}
