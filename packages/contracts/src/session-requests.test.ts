import { describe, expect, it } from "vitest";
import { createBuiltinOperationRef, SESSION_AUTOCOMPLETE_OWNER_ID } from "./owner-ref";
import { SESSION_IMAGE_MAX_ITEMS, SESSION_MESSAGE_TEXT_MAX_CHARS } from "./session";
import { createSessionRequestSchemas } from "./session-requests";
import { projectFileReferenceTargets, stripFileReferenceTargets } from "./file-reference-text";

const schemas = createSessionRequestSchemas();

describe("session request contracts", () => {
	it("round-trips positioned references without removing matching literal author text", () => {
		const text = "Literal @a.ts, then @a.ts here";
		const reference = { scope: "project", path: "a.ts", textOffset: text.lastIndexOf("@a.ts") } as const;
		const request = {
			ref: { cwd: "/project", sessionId: "session" },
			text,
			mode: "followUp",
			fileReferences: [reference],
		};
		expect(schemas.sendMessageRequestSchema.parse(request)).toEqual(request);
		expect(projectFileReferenceTargets(text, [reference])).toEqual({
			text: "Literal @a.ts, then  here",
			offsets: [20],
		});
		expect(stripFileReferenceTargets("legacy\n@a.ts", [{ scope: "project", path: "a.ts" }])).toBe("legacy");
		for (const textOffset of [-1, 1.5, SESSION_MESSAGE_TEXT_MAX_CHARS + 1]) {
			expect(
				schemas.sendMessageRequestSchema.safeParse({ ...request, fileReferences: [{ ...reference, textOffset }] })
					.success,
			).toBe(false);
		}
		expect(() => projectFileReferenceTargets(text, [{ ...reference, textOffset: 0 }])).toThrow("does not match");
		expect(() => projectFileReferenceTargets(text, [reference, reference])).toThrow("does not match");
	});
	it("preserves omitted, empty and removal values when editing a queue entry", () => {
		const request = {
			ref: { cwd: "/project", sessionId: "session" },
			kind: "followUp",
			index: 0,
			expectedRevision: 3,
			expectedText: "expanded prompt",
			text: null,
		};
		expect(schemas.editQueuedRequestSchema.parse(request)).toEqual(request);
		expect(schemas.editQueuedRequestSchema.parse({ ...request, text: "", images: [], fileReferences: [] })).toEqual({
			...request,
			text: "",
			images: [],
			fileReferences: [],
		});
		expect(schemas.editQueuedRequestSchema.safeParse({ ...request, expectedRevision: undefined }).success).toBe(false);
		expect(schemas.editQueuedRequestSchema.safeParse({ ...request, index: -1 }).success).toBe(false);
	});

	it("keeps canonical image encoding, message and attachment bounds at the send boundary", () => {
		const request = { ref: { cwd: "/project", sessionId: "session" }, text: "", mode: "prompt" };
		const image = { type: "image", mimeType: "image/png", data: "Zg==" };
		expect(schemas.sendMessageRequestSchema.parse({ ...request, images: [image] }).images).toEqual([image]);
		for (const data of ["", "Zg=", "Zh==", "Zm9=", "Zg==\n", "????", "Z=g="]) {
			expect(schemas.sendMessageRequestSchema.safeParse({ ...request, images: [{ ...image, data }] }).success).toBe(
				false,
			);
		}
		expect(
			schemas.sendMessageRequestSchema.safeParse({ ...request, images: [{ ...image, mimeType: "text/html" }] }).success,
		).toBe(false);
		expect(
			schemas.sendMessageRequestSchema.safeParse({ ...request, images: Array(SESSION_IMAGE_MAX_ITEMS + 1).fill(image) })
				.success,
		).toBe(false);
		expect(
			schemas.sendMessageRequestSchema.safeParse({ ...request, text: "x".repeat(SESSION_MESSAGE_TEXT_MAX_CHARS + 1) })
				.success,
		).toBe(false);
	});

	it("retains autocomplete normalization and rejects a cursor outside its own text", () => {
		const ref = { cwd: "/project", sessionId: "session" };
		const operation = createBuiltinOperationRef("request", SESSION_AUTOCOMPLETE_OWNER_ID, {
			scope: { kind: "session", ref },
			revision: null,
			generation: 2,
		});
		const request = {
			ref,
			operation,
			runtimeId: "runtime",
			generation: 2,
			deadlineAt: 1,
			text: "@file",
			cursorOffset: 5,
		};
		expect(schemas.extensionAutocompleteRequestSchema.parse({ ...request, force: undefined })).toEqual(request);
		expect(schemas.extensionAutocompleteRequestSchema.safeParse({ ...request, cursorOffset: 6 }).success).toBe(false);
		expect(
			schemas.applyExtensionAutocompleteRequestSchema.parse({
				ref,
				runtimeId: "runtime",
				generation: 2,
				text: "@file",
				cursorOffset: 5,
				prefix: "@",
				item: { value: "file", label: "File", description: undefined },
				force: undefined,
			}),
		).toEqual({
			ref,
			runtimeId: "runtime",
			generation: 2,
			text: "@file",
			cursorOffset: 5,
			prefix: "@",
			item: { value: "file", label: "File" },
		});
	});

	it("requires the addressed runtime and keeps create defaults absent", () => {
		expect(schemas.createSessionRequestSchema.parse({ cwd: "C:\\project" })).toEqual({ cwd: "C:\\project" });
		const request = {
			ref: { cwd: "/project", sessionId: "session" },
			runtimeId: "runtime",
			generation: 0,
			level: "max",
		};
		expect(schemas.setSessionThinkingLevelRequestSchema.parse(request)).toEqual(request);
		expect(schemas.setSessionThinkingLevelRequestSchema.safeParse({ ...request, runtimeId: undefined }).success).toBe(
			false,
		);
		expect(schemas.setSessionThinkingLevelRequestSchema.safeParse({ ...request, level: "ultra" }).success).toBe(false);
		expect(schemas.createSessionRequestSchema.safeParse({ cwd: "/project", unexpected: true }).success).toBe(false);
	});
});
