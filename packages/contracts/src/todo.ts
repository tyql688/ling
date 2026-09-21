import { z } from "zod";
import type { ToolResultSnapshot } from "./companions";
import { piPackageSource, type PiToolOrigin } from "./pi-tool-origin";

/** A read-only projection of rpiv-todo details; the upstream tool owns mutations and replay. */
const todoTaskSchema = z.object({
	id: z.number().int().positive(),
	subject: z.string(),
	description: z.string().optional(),
	activeForm: z.string().optional(),
	status: z.enum(["pending", "in_progress", "completed", "deleted"]),
	blockedBy: z.array(z.number().int().positive()).optional(),
	owner: z.string().optional(),
	metadata: z.record(z.string(), z.json()).optional(),
});
export const todoDetailsSchema = z.object({
	tasks: z.array(todoTaskSchema),
	nextId: z.number().int().positive(),
	error: z.string().optional(),
});
export type TodoDetails = z.infer<typeof todoDetailsSchema>;

/** A finished model turn is not evidence that any individual task was completed. */
export function todoProgress(value: TodoDetails) {
	const tasks = value.tasks.filter((task) => task.status !== "deleted");
	return {
		total: tasks.length,
		completed: tasks.filter((task) => task.status === "completed").length,
		open: tasks.filter((task) => task.status !== "completed"),
	};
}

export const TODO_PACKAGE = "@juicesharp/rpiv-todo";
export const TODO_BUNDLED_SOURCE = "ling:todo";
const TODO_MIN_VERSION = [2, 10, 1] as const;

/** The projected details shape is known for the 2.x line from 2.10.1 on; other majors keep Pi's own rendering. */
function supportedVersion(version: string | null): boolean {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match || Number(match[1]) !== TODO_MIN_VERSION[0]) return false;
	const [minor, patch] = [Number(match[2]), Number(match[3])];
	return minor > TODO_MIN_VERSION[1] || (minor === TODO_MIN_VERSION[1] && patch >= TODO_MIN_VERSION[2]);
}

/** Only rpiv-todo output is projected; another extension registering `todo` keeps its original rendering. */
export function isTodoOrigin(origin: PiToolOrigin | null): boolean {
	if (!origin) return false;
	if (origin.source === TODO_BUNDLED_SOURCE) return true;
	if (origin.source === "ling:ling-todo" && origin.extension === "pi.js") return true;
	return (
		piPackageSource(origin.source) === `npm:${TODO_PACKAGE}` &&
		origin.extension === "index.ts" &&
		supportedVersion(origin.version)
	);
}

export function readTodoResult(value: ToolResultSnapshot | null): TodoDetails | null {
	if (value === null) return null;
	if (!isTodoOrigin(value.origin))
		throw new Error("This Todo result is from an unverified provider. Read the original result in the conversation.");
	return todoDetailsSchema.parse(value.details);
}

/** An item of Ling's own checklist checkpoint, shown read-only. */
interface LegacyTodoItem {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "done" | "cancelled";
	dependsOn: string[];
}
export interface TodoSnapshot {
	value: TodoDetails | null;
	legacy: LegacyTodoItem[] | null;
}
