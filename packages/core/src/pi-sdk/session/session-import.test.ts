import { SessionManager } from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { importPiSession } from "./session-import";

const timestamp = "2026-10-03T00:00:00.000Z";
function content(entries: unknown[], version = 3) {
	return [{ type: "session", version, id: "source", cwd: "/source", timestamp }, ...entries]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
}
const custom = (id: string, parentId: string | null) => ({
	type: "custom",
	id,
	parentId,
	timestamp,
	customType: "fixture",
	data: {},
});

it.each([
	[custom("cycle", "cycle")],
	[custom("first", "second"), custom("second", "first")],
	[custom("duplicate", null), custom("duplicate", null)],
	[custom("orphan", "missing")],
	[{ type: "custom", parentId: null }],
])("rejects invalid session graphs before replacing the current session (%j)", async (...entries) => {
	const apply = vi.fn();
	await expect(importPiSession(content(entries), process.cwd(), apply)).rejects.toMatchObject({
		code: "INVALID_REQUEST",
	});
	expect(apply).not.toHaveBeenCalled();
});

it("preserves branches with independent session identity and releases the temporary file after application", async () => {
	let imported = "";
	await expect(
		importPiSession(
			content([custom("root", null), custom("left", "root"), custom("right", "root")]),
			process.cwd(),
			async (path) => {
				imported = path;
				const manager = SessionManager.open(path, dirname(path));
				expect(manager.getSessionId()).not.toBe("source");
				expect(manager.getCwd()).toBe(process.cwd());
				expect(manager.getTree()[0]?.children).toHaveLength(2);
				return { cancelled: false };
			},
		),
	).resolves.toEqual({ cancelled: false });
	await expect(access(imported)).rejects.toMatchObject({ code: "ENOENT" });
});

it("accepts Pi's migration of flat histories and releases files when replacement fails", async () => {
	let imported = "";
	await expect(
		importPiSession(
			content(
				[
					{
						type: "message",
						timestamp,
						message: { role: "user", content: "Legacy prompt", timestamp: Date.parse(timestamp) },
					},
				],
				1,
			),
			process.cwd(),
			async (path) => {
				imported = path;
				expect(SessionManager.open(path, dirname(path)).buildSessionContext().messages).toHaveLength(1);
				throw new Error("Replacement failed");
			},
		),
	).rejects.toThrow("Replacement failed");
	await expect(access(imported)).rejects.toMatchObject({ code: "ENOENT" });
});
