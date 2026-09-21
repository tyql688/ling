import { describe, expect, it } from "vitest";
import { createInteractions } from "./interactions";
const input = {
	ref: { cwd: "/project", sessionId: "a" },
	kind: "questions" as const,
	title: "Choose",
	questions: [
		{
			id: "q",
			title: "Which?",
			options: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
		},
	],
};
describe("Interactions", () => {
	it.each([false, true])(
		"preserves selected options and supplemental text together (multiple: %s)",
		async (multiple) => {
			const owner = createInteractions(() => undefined);
			const result = owner.request(
				"questions",
				{ ...input, questions: input.questions.map((question) => ({ ...question, multiple })) },
				new AbortController().signal,
			);
			const answer = {
				status: "answered" as const,
				answers: [{ id: "q", selected: multiple ? ["a", "b"] : ["a"], text: "Keep the existing data." }],
			};
			owner.answer(owner.list()[0]!.id, "answer-with-context", answer);
			await expect(result).resolves.toEqual(answer);
		},
	);
	it("requires an explicit approval decision and rejects unavailable options", async () => {
		const owner = createInteractions(() => undefined);
		const approval = owner.request(
			"schedules",
			{ ref: input.ref, kind: "approval", title: "Confirm", body: "**Repeat**: daily" },
			new AbortController().signal,
		);
		const request = owner.list()[0]!;
		expect(request).toMatchObject({ body: "**Repeat**: daily", questions: [] });
		expect(() => owner.answer(request.id, "missing", { status: "answered", answers: [] })).toThrow("explicit approval");
		owner.answer(request.id, "approve", { status: "answered", answers: [], approved: true });
		await expect(approval).resolves.toMatchObject({ approved: true });
		const question = owner.request("questions", input, new AbortController().signal);
		const id = owner.list()[0]!.id;
		expect(() =>
			owner.answer(id, "bad", { status: "answered", answers: [{ id: "q", selected: ["missing"], text: "" }] }),
		).toThrow("unavailable option");
		owner.answer(id, "good", { status: "answered", answers: [{ id: "q", selected: ["b"], text: "" }] });
		await expect(question).resolves.toMatchObject({ status: "answered" });
	});
	it("validates exact questions, preserves pending work on invalid replies, and deduplicates retries", async () => {
		const owner = createInteractions(() => undefined);
		const controller = new AbortController();
		const result = owner.request("questions", input, controller.signal);
		const id = owner.list()[0]!.id;
		expect(() =>
			owner.answer(id, "1", { status: "answered", answers: [{ id: "q", selected: ["a", "b"], text: "" }] }),
		).toThrow();
		expect(owner.list()).toHaveLength(1);
		const answer = { status: "answered" as const, answers: [{ id: "q", selected: [], text: "custom" }] };
		owner.answer(id, "2", answer);
		expect(() => owner.answer(id, "2", answer)).not.toThrow();
		await expect(result).resolves.toEqual(answer);
		expect(owner.list()).toEqual([]);
		expect(() => owner.answer(id, "3", answer)).toThrow();
	});
	it("rejects every pending request on dispose and refuses late replies", async () => {
		const owner = createInteractions(() => undefined);
		const controller = new AbortController();
		const a = owner.request("questions", input, controller.signal);
		const b = owner.request("questions", input, new AbortController().signal);
		const oldId = owner.list()[0]!.id;
		controller.abort(new Error("cancelled"));
		await expect(a).rejects.toThrow();
		expect(owner.list()).toHaveLength(1);
		expect(() => owner.answer(oldId, "late", { status: "skipped", answers: [] })).toThrow();
		owner.dispose();
		await expect(b).rejects.toThrow();
	});
});
