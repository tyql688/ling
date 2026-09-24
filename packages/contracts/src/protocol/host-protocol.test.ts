import { createHostProcedures } from "../api/host-procedures";
import { describe, expect, it } from "vitest";
import {
	deserializeHostFrame,
	HOST_PROTOCOL_VERSION,
	HOST_PROTOCOL_FRAME_MAX_BYTES,
	parseHostClientFrame,
	parseHostServerFrame,
	serializeHostFrame,
	type HostClientFrame,
	type HostServerFrame,
} from "./host-protocol";
import { createSessionRequestSchemas } from "../session-requests";
import { SESSION_IMAGE_MAX_BYTES, SESSION_MESSAGE_TEXT_MAX_CHARS } from "../session";
import { ABSOLUTE_PATH_MAX_CHARS } from "../path-bounds";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS } from "../project";

describe("Host wire frames", () => {
	it("keeps established wire channel names stable as capabilities are added", async () => {
		const additions = new Set([
			"voice:read",
			"voice:configure",
			"voice:transcribe",
			"voice:cancel",
			"builtinFeatures:changed",
			"builtinFeatures:read",
			"builtinFeatures:write",
			"backgroundTasks:changed",
			"backgroundTasks:list",
			"backgroundTasks:read",
			"backgroundTasks:start",
			"backgroundTasks:stop",
			"interactions:answer",
			"interactions:changed",
			"interactions:list",
			"permissions:changed",
			"permissions:prepareRulesFile",
			"permissions:read",
			"permissions:write",
			"project:browseDirectories",
			"questions:changed",
			"questions:list",
			"questions:retry",
			"schedules:changed",
			"schedules:delete",
			"schedules:markRead",
			"schedules:models",
			"schedules:run",
			"schedules:save",
			"schedules:setStatus",
			"schedules:snapshot",
			"schedules:stop",
			"todo:review",
			"todo:snapshot",
			"data:changed",
			"data:retry",
			"data:status",
			"diagnostics:logs",
			"diagnostics:processes",
			"draft:changed",
			"draft:get",
			"draft:list",
			"draft:resolveConflict",
			"draft:write",
			"models:open-external",
			"editorLanguage:open",
			"editorLanguage:change",
			"editorLanguage:close",
			"editorLanguage:call",
			"editorLanguage:cancel",
			"editorLanguage:format",
			"editorLanguage:save",
			"editorLanguage:diagnostics",
			"pi-settings:changed",
			"session:catalog-changed",
			"session:readArchivedTranscript",
			"session:retryTurn",
			"userState:changed",
			"userState:get",
			"userState:importLegacy",
			"userState:update",
		]);
		const channels = Object.values(createHostProcedures()).flatMap((table) =>
			Object.values(table).map((procedure) => procedure.channel),
		);
		expect(new Set(channels).size).toBe(channels.length);
		expect(channels.filter((channel) => additions.has(channel)).sort()).toEqual([...additions].sort());
		// Fingerprint the established channel set to detect accidental renames or removals.
		const retained = channels.filter((channel) => !additions.has(channel)).sort();
		expect(retained).toHaveLength(166);
		expect(
			[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(retained.join("\n"))))]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join(""),
		).toBe("f98eed9d5fbe62a424f1b48c4d722c7e7b1198cba0a3da94cd174d71bc36c865");
	});

	it("fits a legal maximum image queue edit including JSON-escaped old and new text", () => {
		const image = {
			type: "image",
			mimeType: "image/png",
			data: btoa("\0".repeat(SESSION_IMAGE_MAX_BYTES)),
		};
		const text = "\u0000".repeat(SESSION_MESSAGE_TEXT_MAX_CHARS);
		const path = `/${"\u0001".repeat(ABSOLUTE_PATH_MAX_CHARS - 1)}`;
		const request = createSessionRequestSchemas().editQueuedRequestSchema.parse({
			ref: { cwd: path, sessionId: "session" },
			kind: "followUp",
			index: 0,
			expectedRevision: 0,
			expectedText: text,
			text,
			images: [image, image],
			fileReferences: Array.from({ length: PROJECT_FILE_REFERENCE_MAX_ITEMS }, () => ({ scope: "external", path })),
		});
		const frame = serializeHostFrame({ kind: "request", id: "request", method: "session:editQueued", args: [request] });
		expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(HOST_PROTOCOL_FRAME_MAX_BYTES);
	});

	it.each<HostClientFrame>([
		{
			kind: "hello",
			protocolVersion: HOST_PROTOCOL_VERSION,
			clientId: "client",
			product: "web",
			token: "isolated-test-token",
			lastEventSequence: null,
			pendingRequestIds: ["pending"],
		},
		{ kind: "request", id: "request", method: "session:list", args: [] },
		{ kind: "cancel", id: "request" },
		{ kind: "ack", eventSequence: 3, requestIds: ["request"] },
	])("round trips client $kind", (frame) => {
		expect(parseHostClientFrame(deserializeHostFrame(serializeHostFrame(frame)))).toEqual(frame);
	});

	it.each<HostServerFrame>([
		{ kind: "response", id: "request", ok: true, result: { bytes: new Uint8Array([0, 127, 255]) } },
		{
			kind: "response",
			id: "request",
			ok: false,
			error: {
				kind: "domain",
				error: {
					code: "PROJECT_NOT_OPEN",
					category: "lifecycle",
					message: "Reopen project",
					retryable: true,
					userAction: "reopenProject",
					details: { cwd: "/project" },
				},
			},
		},
		{ kind: "fatal", error: { code: "UNAUTHORIZED", message: "Authentication failed" } },
		{ kind: "event", sequence: 1, channel: "session:event", payload: { value: "中文" } },
	])("round trips server $kind", (frame) => {
		expect(parseHostServerFrame(deserializeHostFrame(serializeHostFrame(frame)))).toEqual(frame);
	});

	it.each([
		{ kind: "cancel", id: "" },
		{ kind: "cancel", id: "request", injected: true },
		{ kind: "ack", eventSequence: -1, requestIds: [] },
		{ kind: "request", id: "request", method: "method", args: Array(9).fill(null) },
	])("rejects malformed client frames: %j", (frame) => {
		expect(() => parseHostClientFrame(frame)).toThrow();
	});

	it("rejects unknown domain error codes and invalid JSON", () => {
		expect(() =>
			parseHostServerFrame({
				kind: "response",
				id: "id",
				ok: false,
				error: { kind: "domain", error: { code: "UNMODELED", category: "runtime", message: "bad", retryable: false } },
			}),
		).toThrow();
		expect(() => deserializeHostFrame("{")).toThrow();
	});
});
