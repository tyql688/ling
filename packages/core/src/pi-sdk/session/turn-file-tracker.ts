import { isInside } from "@ling/core/paths";
import { createReviewFileIdentity, type ReviewSnapshotFile } from "@ling/core/change-review/change-review";
import type { SessionRuntimeChangeReviewEvent } from "@ling/core/pi-protocol/runtime-types";
import type { TurnFileTrackingFailureCode } from "@ling/core/pi-protocol/turn-review";
import { FILE_HEADERS_ONLY, formatPatch, type StructuredPatch, structuredPatch } from "diff";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PiToolCallEvent, PiToolResultEvent } from "../types";

// The change review is a text preview, not a workspace mirror; the bounds below keep a single tool hook from
// retaining/diffing project data without limit.
/** Per-file capture byte limit (2MiB); larger files only record their path, never enter the diff body. */
const TURN_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Cumulative capture byte limit per turn (32MiB); beyond it a TURN_LIMIT is recorded so one turn cannot blow up memory. */
const TURN_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
/** Max tracked paths per turn; 512 covers common edit sets, more adds no interactive value. */
const TURN_FILE_MAX_ITEMS = 512;
/** Tool calls can target the same path repeatedly, so path count alone cannot bound this map. */
const TURN_PENDING_CALL_MAX_ITEMS = 512;
/** Two events per tool call plus a small lifecycle cushion; overflow fails the turn tracker closed. */
const TURN_EVENT_QUEUE_MAX_ITEMS = TURN_PENDING_CALL_MAX_ITEMS * 2 + 16;
/** structuredPatch computation timeout; 5s keeps oversized text diffs from blocking the tool hook. */
const DIFF_TIMEOUT_MS = 5_000;

interface TrackedPath {
	absolutePath: string;
	readPath: string;
	relativePath: string;
}

interface CapturedText {
	text: string | null;
	bytes: number;
}

interface TurnFileTrackingResult {
	files: ReviewSnapshotFile[];
	failureCode: TurnFileTrackingFailureCode | null;
}

export interface TurnFileTracker {
	startRun(): Promise<void>;
	finishRun(): Promise<TurnFileTrackingResult>;
	handleToolCall(event: PiToolCallEvent): Promise<void>;
	handleToolResult(event: PiToolResultEvent): Promise<void>;
	dispose(): void;
}

function errnoCode(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function normalizedRelativePath(cwd: string, absolutePath: string): string | null {
	const child = relative(cwd, absolutePath);
	if (child === "" || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) return null;
	return child.split(sep).join("/");
}

async function nearestExistingPath(path: string): Promise<{ path: string; finalTargetExists: boolean } | null> {
	let candidate = path;
	let finalTargetExists = true;
	for (;;) {
		try {
			await lstat(candidate);
			return { path: candidate, finalTargetExists };
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
			const parent = dirname(candidate);
			if (parent === candidate) return null;
			candidate = parent;
			finalTargetExists = false;
		}
	}
}

async function resolveTrackedPath(cwd: string, canonicalRoot: string, rawPath: string): Promise<TrackedPath | null> {
	if (rawPath.length === 0 || rawPath.includes("\0")) return null;
	const absolutePath = resolve(cwd, rawPath);
	const relativePath = normalizedRelativePath(cwd, absolutePath);
	if (relativePath === null) return null;

	const existing = await nearestExistingPath(absolutePath);
	if (existing === null) return null;
	const info = await lstat(existing.path);
	if (existing.finalTargetExists && info.isSymbolicLink()) return null;
	if (existing.finalTargetExists && !info.isFile()) return null;
	if (!existing.finalTargetExists && !info.isDirectory() && !info.isSymbolicLink()) return null;
	const canonicalExisting = await realpath(existing.path);
	if (!isInside(canonicalRoot, canonicalExisting)) return null;
	return {
		absolutePath,
		readPath: existing.finalTargetExists ? canonicalExisting : absolutePath,
		relativePath,
	};
}

async function readTextFile(path: string, maxBytes: number): Promise<CapturedText | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		const safetyFlags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
		handle = await open(path, constants.O_RDONLY | safetyFlags);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return { text: null, bytes: 0 };
		if (["ELOOP", "EISDIR", "EINVAL"].includes(errnoCode(error) ?? "")) return null;
		throw error;
	}

	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) return null;
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > maxBytes) return null;
		const bytes = buffer.subarray(0, offset);
		if (bytes.includes(0)) return null;
		try {
			return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes: offset };
		} catch (error) {
			if (error instanceof TypeError) return null;
			throw error;
		}
	} finally {
		await handle.close();
	}
}

function diffLabel(prefix: "a" | "b", path: string): string {
	const label = `${prefix}/${path}`;
	return /[\t\r\n"\\]/.test(label) ? JSON.stringify(label) : label;
}

function createStructuredPatch(
	oldName: string,
	newName: string,
	before: string,
	after: string,
	timeout: number,
): Promise<StructuredPatch | undefined> {
	return new Promise((resolvePatch) => {
		structuredPatch(oldName, newName, before, after, undefined, undefined, {
			context: 3,
			stripTrailingCr: false,
			timeout,
			callback: resolvePatch,
		});
	});
}

async function createTrackedReviewFile(
	path: string,
	before: string | null,
	after: string | null,
	timeout: number,
): Promise<ReviewSnapshotFile | null | "timeout"> {
	if (before === after) return null;
	const oldName = before === null ? "/dev/null" : diffLabel("a", path);
	const newName = after === null ? "/dev/null" : diffLabel("b", path);
	const patch = await createStructuredPatch(oldName, newName, before ?? "", after ?? "", timeout);
	if (patch === undefined) return "timeout";
	const file: ReviewSnapshotFile = {
		path,
		status: before === null ? "added" : after === null ? "deleted" : "modified",
		additions: patch.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.startsWith("+")).length, 0),
		deletions: patch.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.startsWith("-")).length, 0),
		diff: formatPatch(patch, FILE_HEADERS_ONLY),
	};
	file.identity = createReviewFileIdentity(file);
	return file;
}

function toolPath(event: PiToolCallEvent): string | null {
	if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "delete") return null;
	if (event.input === null || typeof event.input !== "object" || Array.isArray(event.input)) return null;
	const path = (event.input as Record<string, unknown>).path;
	return typeof path === "string" ? path : null;
}

export function createTurnFileTracker(
	cwd: string,
	onEvent: (event: SessionRuntimeChangeReviewEvent) => void,
): TurnFileTracker {
	const maxFileBytes = TURN_FILE_MAX_BYTES;
	const maxTurnBytes = TURN_CAPTURE_MAX_BYTES;
	const maxFiles = TURN_FILE_MAX_ITEMS;
	const maxPendingCalls = TURN_PENDING_CALL_MAX_ITEMS;
	const maxQueuedEvents = TURN_EVENT_QUEUE_MAX_ITEMS;
	const diffTimeout = DIFF_TIMEOUT_MS;
	let canonicalRoot: string | null = null;
	let active = false;
	let disposed = false;
	let failureCode: TurnFileTrackingFailureCode | null = null;
	let capturedBytes = 0;
	const pending = new Map<string, TrackedPath>();
	const originalText = new Map<string, string | null>();
	const diffBytes = new Map<string, number>();
	const files = new Map<string, ReviewSnapshotFile>();
	let trackedDiffBytes = 0;
	let operationTail: Promise<void> = Promise.resolve();
	let queuedEvents = 0;
	let generation = 0;

	function fail(code: TurnFileTrackingFailureCode): void {
		if (disposed || failureCode !== null) return;
		failureCode = code;
		pending.clear();
		onEvent({ type: "changeReviewTrackingFailed", code });
	}

	function reset(): void {
		if (disposed) return;
		active = true;
		failureCode = null;
		capturedBytes = 0;
		pending.clear();
		originalText.clear();
		diffBytes.clear();
		files.clear();
		trackedDiffBytes = 0;
		canonicalRoot = null;
	}

	async function getCanonicalRoot(): Promise<string> {
		if (canonicalRoot !== null) return canonicalRoot;
		const resolved = await realpath(cwd);
		canonicalRoot = resolved;
		return resolved;
	}

	async function startMutation(event: PiToolCallEvent): Promise<void> {
		const rawPath = toolPath(event);
		if (failureCode !== null || rawPath === null) return;
		const trackedPath = await resolveTrackedPath(cwd, await getCanonicalRoot(), rawPath);
		if (trackedPath === null) return;
		const captured = await readTextFile(trackedPath.readPath, maxFileBytes);
		if (captured === null) return;
		if (disposed) return;
		if (!originalText.has(trackedPath.relativePath)) {
			if (originalText.size >= maxFiles || capturedBytes + captured.bytes > maxTurnBytes) {
				fail("TURN_LIMIT_EXCEEDED");
				return;
			}
			originalText.set(trackedPath.relativePath, captured.text);
			capturedBytes += captured.bytes;
		}
		if (!pending.has(event.toolCallId) && pending.size >= maxPendingCalls) {
			fail("TURN_LIMIT_EXCEEDED");
			return;
		}
		pending.set(event.toolCallId, trackedPath);
	}

	async function finishMutation(event: PiToolResultEvent): Promise<void> {
		const trackedPath = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (failureCode !== null || trackedPath === undefined) return;
		const resolvedPath = await resolveTrackedPath(cwd, await getCanonicalRoot(), trackedPath.absolutePath);
		if (resolvedPath === null) {
			fail("CAPTURE_FAILED");
			return;
		}
		const captured = await readTextFile(resolvedPath.readPath, maxFileBytes);
		if (captured === null) {
			fail("CAPTURE_FAILED");
			return;
		}
		if (disposed) return;
		if (!originalText.has(trackedPath.relativePath)) return;
		const before = originalText.get(trackedPath.relativePath) ?? null;
		const file = await createTrackedReviewFile(trackedPath.relativePath, before, captured.text, diffTimeout);
		if (disposed) return;
		if (file === "timeout") {
			fail("DIFF_LIMIT_EXCEEDED");
			return;
		}
		const previousDiffBytes = diffBytes.get(trackedPath.relativePath) ?? 0;
		const nextDiffBytes = file === null ? 0 : Buffer.byteLength(file.diff ?? "", "utf8");
		if (trackedDiffBytes - previousDiffBytes + nextDiffBytes > maxTurnBytes) {
			fail("TURN_LIMIT_EXCEEDED");
			return;
		}
		trackedDiffBytes += nextDiffBytes - previousDiffBytes;
		if (file === null) {
			diffBytes.delete(trackedPath.relativePath);
			files.delete(trackedPath.relativePath);
		} else {
			diffBytes.set(trackedPath.relativePath, nextDiffBytes);
			files.set(trackedPath.relativePath, file);
		}
		onEvent({
			type: "changeReviewFileUpdated",
			path: trackedPath.relativePath,
			file,
		});
	}

	function enqueue(operation: () => Promise<void>): Promise<void> {
		if (failureCode !== null) return Promise.resolve();
		if (queuedEvents >= maxQueuedEvents) {
			fail("TURN_LIMIT_EXCEEDED");
			return Promise.resolve();
		}
		queuedEvents += 1;
		const eventGeneration = generation;
		const queued = operationTail.then(async () => {
			if (disposed || eventGeneration !== generation) return;
			try {
				await operation();
			} catch {
				fail("CAPTURE_FAILED");
			}
		});
		operationTail = queued.then(
			() => {
				queuedEvents -= 1;
			},
			() => {
				queuedEvents -= 1;
			},
		);
		return queued;
	}

	return {
		async startRun() {
			await operationTail;
			if (disposed) return;
			generation += 1;
			reset();
		},
		async finishRun() {
			const finishingGeneration = generation;
			active = false;
			await operationTail;
			if (disposed || finishingGeneration !== generation) return { files: [], failureCode: "CAPTURE_FAILED" };
			pending.clear();
			return {
				files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
				failureCode,
			};
		},
		handleToolCall(event) {
			if (disposed || !active || failureCode !== null) return Promise.resolve();
			return enqueue(() => startMutation(event));
		},
		handleToolResult(event) {
			if (disposed || !active || failureCode !== null) return Promise.resolve();
			return enqueue(() => finishMutation(event));
		},
		dispose() {
			disposed = true;
			active = false;
			generation += 1;
			pending.clear();
			originalText.clear();
			diffBytes.clear();
			files.clear();
		},
	};
}
