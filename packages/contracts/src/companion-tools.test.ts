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

	it("keeps omitted schedule updates distinct from explicit resets and validates changed schedules", () => {
		const input = { id: "2d9411b1-91c8-412b-9db1-98ec237d7b67", expectedRevision: 3 };
		const update = companionTools.schedule_update.input;
		expect(update.parse({ ...input, changes: { title: "New title", model: null } }).changes).toEqual({
			title: "New title",
			model: null,
		});
		expect(update.parse({ ...input, changes: { status: "paused" } }).changes).toEqual({ status: "paused" });
		expect(
			update.parse({
				...input,
				changes: { schedule: { kind: "calendar", time: "10:30", timeZone: "Asia/Shanghai", days: [1, 3] } },
			}).changes.schedule,
		).toEqual({ kind: "calendar", time: "10:30", timeZone: "Asia/Shanghai", days: [1, 3] });
		for (const changes of [{}, { title: null }, { unexpected: true }, { schedule: { kind: "interval", minutes: 1 } }])
			expect(() => update.parse({ ...input, changes })).toThrow();
	});
});
