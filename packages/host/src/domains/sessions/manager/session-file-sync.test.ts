import { access, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../../test/temporary-directory";
import { createSessionFileSyncController } from "./session-file-sync";

it("allows deferred first writes but stops sends and refreshes when an accepted file disappears", async () => {
	const root = await temporaryDirectory("session-file-sync");
	const file = join(root, "session.jsonl");
	const refreshFromDisk = vi.fn(async () => {});
	const onSyncFailed = vi.fn();
	const runtime = { sessionFile: file, isBusy: () => false, refreshFromDisk };
	const sync = createSessionFileSyncController({
		runtime: () => runtime,
		isCurrent: () => true,
		sessionId: () => "fixture",
		onSyncFailed,
	});
	try {
		await sync.acceptCurrentState();
		expect(await sync.hasExternalDivergence()).toBe(false);
		await writeFile(file, '{"type":"session","id":"fixture"}\n');
		await sync.acceptCurrentState();
		await rename(file, `${file}.moved`);
		await expect(sync.hasExternalDivergence()).rejects.toMatchObject({ code: "SESSION_FILE_DIVERGED" });
		await sync.acceptCurrentState();
		await expect(sync.hasExternalDivergence()).rejects.toMatchObject({ code: "SESSION_FILE_DIVERGED" });
		onSyncFailed.mockClear();
		sync.scheduleExternalCheck();
		await vi.waitFor(() =>
			expect(onSyncFailed).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_FILE_DIVERGED" })),
		);
		expect(refreshFromDisk).not.toHaveBeenCalled();
		await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		sync.stop();
		await rm(root, { recursive: true, force: true });
	}
});
