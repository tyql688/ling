import { createHostDatabase, type HostDatabase } from "../../storage/database";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppSettingsStore, type AppSettingsStore } from "./app-settings";

const roots: string[] = [];
const stores: AppSettingsStore[] = [];
const databases: HostDatabase[] = [];
function database(userDataDir: string) {
	const instance = createHostDatabase(userDataDir);
	databases.push(instance);
	return instance;
}

async function createStore() {
	const userDataDir = await temporaryDirectory("settings");
	roots.push(userDataDir);
	const store = createAppSettingsStore({ userDataDir, database: database(userDataDir) });
	stores.push(store);
	return { store, userDataDir };
}

afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.dispose()));
	for (const instance of databases.splice(0)) instance.dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("app settings ownership", () => {
	it("keeps cached preferences and shutdown admission separate between instances", async () => {
		const first = await createStore();
		const second = await createStore();
		await first.store.updateAppSettings({ type: "keepAwakeWhileRunning", enabled: true });
		expect(first.store.getAppSettingsFast().keepAwakeWhileRunning).toBe(true);
		expect(second.store.getAppSettingsFast().keepAwakeWhileRunning).toBe(false);
		await first.store.dispose();
		await expect(
			first.store.updateAppSettings({ type: "keepAwakeWhileRunning", enabled: false }),
		).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		await second.store.updateAppSettings({ type: "fileMentionsRespectGitignore", enabled: true });
		expect(second.store.getAppSettingsFast().fileMentionsRespectGitignore).toBe(true);
		const restarted = createAppSettingsStore({ userDataDir: first.userDataDir, database: database(first.userDataDir) });
		stores.push(restarted);
		await restarted.updateAppSettings({ type: "playNotificationSounds", enabled: false });
		expect(restarted.getAppSettingsFast()).toMatchObject({
			keepAwakeWhileRunning: true,
			playNotificationSounds: false,
		});
	});

	it("drains admitted writes in order before disposal resolves", async () => {
		const { store, userDataDir } = await createStore();
		const first = store.updateAppSettings({ type: "keepAwakeWhileRunning", enabled: true });
		const second = store.updateAppSettings({ type: "fileMentionsRespectGitignore", enabled: true });
		const disposed = store.dispose();
		expect(store.dispose()).toBe(disposed);
		await Promise.all([first, second, disposed]);

		const reopened = createAppSettingsStore({ userDataDir, database: database(userDataDir) });
		stores.push(reopened);
		expect(reopened.getAppSettingsFast()).toMatchObject({
			keepAwakeWhileRunning: true,
			fileMentionsRespectGitignore: true,
		});
	});

	it("keeps corruption visible after a temporary preference fallback and accepts authoritative recovery", async () => {
		const { store, userDataDir } = await createStore();
		await writeFile(join(userDataDir, "settings.json"), "{broken");
		expect(store.getAppSettingsFast().keepAwakeWhileRunning).toBe(false);
		expect(store.readAppSettings().status).toBe("recoveryRequired");
		await store.resetAppSettings();
		expect(await readFile(join(userDataDir, "settings.json"), "utf8")).toBe("{broken");
		await store.updateAppSettings({ type: "keepAwakeWhileRunning", enabled: true });
		expect(store.readAppSettings().status).toBe("ready");
		expect(store.getAppSettingsFast().keepAwakeWhileRunning).toBe(true);
	});
});
