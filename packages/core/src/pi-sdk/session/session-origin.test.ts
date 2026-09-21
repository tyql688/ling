import { describe, expect, it } from "vitest";
import { MANUAL_FORK_ENTRY_TYPE, readSessionOrigin, recordManualForkOrigin } from "./session-origin";

const timestamp = "2026-09-10T00:00:00.000Z";
const header = { id: "fork", timestamp, parentSession: "/sessions/original.jsonl" };
const marker = (sessionId: string) => ({
	type: "custom",
	customType: MANUAL_FORK_ENTRY_TYPE,
	data: { version: 1, sessionId },
});
const name = (value: string, time = timestamp) => ({ type: "session_info", name: value, timestamp: time });

describe("session-bound manual fork provenance", () => {
	it("survives arbitrary renames and transcript entries", () => {
		expect(readSessionOrigin(header, [marker("fork"), name("New title"), { type: "message" }])).toEqual({
			recorded: true,
			manualFork: true,
		});
	});

	it("does not inherit the parent marker or display name in a plugin fork", () => {
		expect(readSessionOrigin(header, [marker("parent"), name("Parent (fork)")])).toEqual({
			recorded: false,
			manualFork: false,
		});
	});

	it("recognizes a new manual fork of an already marked fork", () => {
		expect(readSessionOrigin(header, [marker("parent"), marker("fork"), name("Nested")]).manualFork).toBe(true);
	});

	it("recovers renamed legacy forks from their own initial naming history", () => {
		expect(readSessionOrigin(header, [name("Original (fork)"), name("Renamed", "2026-09-10T00:00:01Z")])).toEqual({
			recorded: false,
			manualFork: true,
		});
	});

	it("does not infer origin from copied older names or an unrelated current title", () => {
		expect(readSessionOrigin(header, [name("Parent (fork)", "2026-09-09T23:59:59Z"), name("Child")]).manualFork).toBe(
			false,
		);
	});

	it("does not create a relation without a parent header", () => {
		expect(readSessionOrigin({ id: "fork", timestamp }, [marker("fork")]).manualFork).toBe(false);
	});

	it("reports invalid owned metadata instead of projecting an authoritative false", () => {
		expect(() => readSessionOrigin(header, [{ ...marker("fork"), data: { version: 2, sessionId: "fork" } }])).toThrow();
	});

	it("writes a Pi custom entry tied to the new session identity", () => {
		const entries: unknown[] = [];
		recordManualForkOrigin({
			getSessionId: () => "fork",
			appendCustomEntry(customType, data) {
				entries.push({ type: "custom", customType, data });
				return "entry";
			},
		});
		expect(entries).toEqual([marker("fork")]);
	});
});
