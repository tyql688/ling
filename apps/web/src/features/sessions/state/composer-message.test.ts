import { describe, expect, it, vi } from "vitest";
import { SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";
import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import { appendUnsentMessages, prepareComposerMessage } from "./composer-message";
import { projectFileReferenceTargets } from "@ling/contracts/file-reference-text";

vi.mock("@renderer/lib/platform", () => ({ isWindows: false }));

function draft(fields: Partial<SessionDraft> = {}): SessionDraft {
	return { text: "", attachments: [], fileReferences: [], pastedBlocks: [], reviewComments: [], ...fields };
}

describe("composer message preparation", () => {
	it("expands inline context at the recorded position and retains later author text", () => {
		const source = draft({
			text: "Compare  then  please",
			pastedBlocks: [{ id: "p", text: "PASTED_BODY" }],
			fileReferences: [{ id: "f", scope: "project", path: "src/main.ts" }],
			contextPositions: [
				{ kind: "file", id: "f", offset: 8 },
				{ kind: "paste", id: "p", offset: 14 },
			],
		});
		const prepared = prepareComposerMessage(source);
		if (prepared.status !== "ready") throw new Error("Expected inline context to be sendable");
		expect(prepared.message.text.indexOf("src/main.ts")).toBeLessThan(prepared.message.text.indexOf("then"));
		expect(prepared.message.text.indexOf("PASTED_BODY")).toBeGreaterThan(prepared.message.text.indexOf("then"));
		expect(prepared.message.text.endsWith(" please")).toBe(true);
		expect(prepared.message.text).not.toContain("contextPositions");
		expect(projectFileReferenceTargets(prepared.message.text, prepared.message.fileReferences).text).not.toContain(
			"@src/main.ts",
		);
	});
	it("keeps author text and chip order while removing UI metadata from references", () => {
		const source = draft({
			text: "  Review this\n",
			pastedBlocks: [{ id: "paste", text: "PASTED_BODY" }],
			reviewComments: [
				{ id: "comment", filePath: "src/main.ts", rangeLabel: "L2", text: "REVIEW_BODY", excerpt: "+line" },
			],
			fileReferences: [{ id: "reference", scope: "project", path: "src/main.ts", lineRange: { start: 2, end: 3 } }],
		});
		const original = structuredClone(source);
		const prepared = prepareComposerMessage(source);
		expect(prepared.status).toBe("ready");
		if (prepared.status !== "ready") throw new Error("Expected a sendable message");
		expect(prepared.message.submittedText).toBe(source.text);
		expect(prepared.message.text.startsWith(source.text)).toBe(true);
		expect(prepared.message.text.indexOf("PASTED_BODY")).toBeLessThan(prepared.message.text.indexOf("REVIEW_BODY"));
		expect(prepared.message.text.indexOf("REVIEW_BODY")).toBeLessThan(prepared.message.text.lastIndexOf("src/main.ts"));
		expect(prepared.message.fileReferences).toEqual([
			{ scope: "project", path: "src/main.ts", lineRange: { start: 2, end: 3 } },
		]);
		expect(source).toEqual(original);
	});

	it("keeps positioned queue references stable across repeated edit and save projections", () => {
		let source = draft({
			text: "Compare  with  please",
			fileReferences: [
				{ id: "a", scope: "project", path: "a.ts" },
				{ id: "b", scope: "project", path: "b.ts" },
			],
			contextPositions: [
				{ kind: "file", id: "a", offset: 8 },
				{ kind: "file", id: "b", offset: 14 },
			],
		});
		for (let iteration = 0; iteration < 3; iteration += 1) {
			const prepared = prepareComposerMessage(source);
			if (prepared.status !== "ready") throw new Error("Expected a sendable queue draft");
			expect(prepared.message.text).toBe("Compare @a.ts with @b.ts please");
			const projected = projectFileReferenceTargets(prepared.message.text, prepared.message.fileReferences);
			source = {
				...source,
				text: projected.text,
				contextPositions: source.fileReferences.map((reference, index) => ({
					kind: "file",
					id: reference.id,
					offset: projected.offsets[index]!,
				})),
			};
		}
	});

	it("distinguishes empty input from image-only and reference-only messages", () => {
		expect(prepareComposerMessage(draft({ text: " \n\t" }))).toEqual({ status: "empty" });
		expect(
			prepareComposerMessage(
				draft({ attachments: [{ id: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,Zg==" }] }),
			),
		).toEqual({
			status: "ready",
			message: {
				text: "",
				submittedText: null,
				fileReferences: [],
				images: [{ type: "image", mimeType: "image/png", data: "Zg==" }],
			},
		});
		const reference = prepareComposerMessage(
			draft({ fileReferences: [{ id: "ref", scope: "external", path: "/project/reference.txt" }] }),
		);
		expect(reference.status).toBe("ready");
		if (reference.status !== "ready") throw new Error("Expected a reference-only message");
		expect(reference.message.text).toContain("/project/reference.txt");
		expect(reference.message.submittedText).toBeNull();
	});

	it("bounds the final combined payload before converting any image", () => {
		const source = draft({
			text: "x".repeat(SESSION_MESSAGE_TEXT_MAX_CHARS - 10),
			pastedBlocks: [{ id: "paste", text: "more context" }],
			attachments: [{ id: "bad", mimeType: "invalid", dataUrl: "invalid" }],
		});
		expect(prepareComposerMessage(source)).toEqual({ status: "tooLong" });
		expect(source.attachments).toHaveLength(1);
	});

	it("leaves an invalid attachment intact so its failure can be shown without losing the draft", () => {
		const source = draft({
			text: "Keep me",
			attachments: [{ id: "bad", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,Zg==" }],
		});
		expect(() => prepareComposerMessage(source)).toThrow("Unsupported draft image type");
		expect(source.text).toBe("Keep me");
		expect(source.attachments).toHaveLength(1);
	});

	it("recovers images and positioned references alongside newer input without expanding Pi text", () => {
		const current = draft({
			text: "Keep  this",
			pastedBlocks: [{ id: "keep", text: "newer paste" }],
			contextPositions: [{ kind: "paste", id: "keep", offset: 5 }],
		});
		const original = structuredClone(current);
		const images = [{ type: "image" as const, mimeType: "image/png" as const, data: "Zg==" }];
		const restored = appendUnsentMessages(current, [
			{
				text: "EXPANDED_PI_COMMAND_BODY",
				draftText: "Compare  and  🐱",
				images,
				fileReferences: [
					{ scope: "project", path: "a.ts", textOffset: 8 },
					{ scope: "project", path: "b.ts", textOffset: 18 },
				],
			},
		]);
		expect(restored.omitted).toBe(0);
		expect(restored.draft.text).toBe("Keep  this\n\nCompare  and  🐱");
		const prepared = prepareComposerMessage(restored.draft);
		if (prepared.status !== "ready") throw new Error("Expected recovered context to be sendable");
		expect(prepared.message.text).toContain("Compare @a.ts and @b.ts 🐱");
		expect(prepared.message.text).toContain("newer paste");
		expect(prepared.message.text).not.toContain("EXPANDED_PI_COMMAND_BODY");
		expect(prepared.message.images).toEqual(images);
		expect(current).toEqual(original);
	});

	it("reports whole messages that cannot fit instead of silently trimming their text or attachments", () => {
		const current = draft({ text: "x".repeat(SESSION_MESSAGE_TEXT_MAX_CHARS) });
		const restored = appendUnsentMessages(current, [
			{
				text: "unsent",
				draftText: "unsent",
				images: [],
				fileReferences: [],
			},
		]);
		expect(restored).toEqual({ draft: current, omitted: 1 });
	});
});
