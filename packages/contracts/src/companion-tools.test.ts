import { describe, expect, it } from "vitest";
import { z } from "zod";
import { companionTools } from "./companion-tools";

const create = companionTools.schedule_create.input;
const task = {
	title: "Daily briefing",
	prompt: "Summarize progress",
	cwd: "/project",
	sessionId: null,
	model: null,
	thinking: null,
	missed: "skip",
	notifications: "none",
};

describe("companion tool schemas", () => {
	it.each([companionTools.ask_user, companionTools.ask_user_async])(
		"rejects ambiguous question and option identities before opening a request",
		(tool) => {
			const question = { id: "theme", title: "Choose a theme", options: [{ id: "light", label: "Light" }] };
			expect(() => tool.input.parse({ title: "Setup", questions: [question, question] })).toThrow("Question IDs");
			expect(() =>
				tool.input.parse({
					title: "Setup",
					questions: [{ ...question, options: [...question.options, ...question.options] }],
				}),
			).toThrow("Option IDs");
			expect(
				tool.input.parse({ title: "Setup", questions: [question, { ...question, id: "editor-theme" }] }).questions,
			).toHaveLength(2);
		},
	);

	it("publish JSON schemas without union constructs that providers mishandle", () => {
		for (const [name, tool] of Object.entries(companionTools)) {
			const schema = JSON.stringify(z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }));
			expect(schema, name).not.toContain('"oneOf"');
			expect(schema, name).not.toContain('"$ref"');
		}
	});

	it("turns the flat agent schedule into the exact schedule, idempotently", () => {
		const calendar = create.parse({
			...task,
			schedule: { kind: "calendar", time: "09:00", timeZone: "Asia/Shanghai", days: [1, 2], at: 5 },
		});
		expect(calendar.schedule).toEqual({ kind: "calendar", time: "09:00", timeZone: "Asia/Shanghai", days: [1, 2] });
		expect(create.parse(calendar)).toEqual(calendar);
		const interval = create.parse({ ...task, schedule: { kind: "interval", minutes: 30, anchor: 1_000 } });
		expect(interval.schedule).toEqual({ kind: "interval", minutes: 30, anchor: 1_000 });
		expect(() => create.parse({ ...task, schedule: { kind: "once", time: "09:00" } })).toThrow();
		const minimal = create.parse({
			title: task.title,
			prompt: task.prompt,
			cwd: task.cwd,
			schedule: { kind: "once", at: 2_000 },
		});
		expect(minimal).toMatchObject({
			sessionId: null,
			model: null,
			thinking: null,
			missed: "skip",
			notifications: "attention",
		});
		expect(() => create.parse({ ...task, schedule: { kind: "interval", minutes: 1 } })).toThrow();
	});
});
