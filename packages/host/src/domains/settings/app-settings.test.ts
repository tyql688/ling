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
	const db = database(userDataDir);
	const store = createAppSettingsStore({ userDataDir, database: db });
	stores.push(store);
	return { store, userDataDir, db };
}

afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.dispose()));
	for (const instance of databases.splice(0)) instance.dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("app settings ownership", () => {
	it.each([undefined, false, true])("upgrades SQLite version 3 with automatic downloads %s", async (autoDownload) => {
		const { store, userDataDir, db } = await createStore();
		await store.updateAppSettings({ type: "keepRunningOnWindowClose", enabled: true });
		await store.updateAppSettings({ type: "notifyAttentionNeeded", enabled: false });
		await store.updateAppSettings({ type: "fileMentionsRespectGitignore", enabled: true });
		if (autoDownload === undefined) db.run("DELETE FROM app_settings WHERE key='autoDownloadUpdates'");
		else await store.updateAppSettings({ type: "autoDownloadUpdates", enabled: autoDownload });
		db.run("UPDATE schema_version SET version=3");
		db.run("INSERT INTO drafts VALUES('retained', '{\"text\":\"unsent\"}',7,11)");
		const retained = db.all("SELECT key,value FROM app_settings WHERE key!='autoDownloadUpdates' ORDER BY key");
		await store.dispose();
		db.dispose();

		const upgraded = database(userDataDir);
		const reopened = createAppSettingsStore({ userDataDir, database: upgraded });
		stores.push(reopened);
		expect(reopened.readAppSettings()).toMatchObject({
			status: "ready",
			settings: {
				autoDownloadUpdates: autoDownload ?? true,
				keepRunningOnWindowClose: true,
				notifyAttentionNeeded: false,
				fileMentionsRespectGitignore: true,
			},
		});
		expect(upgraded.get("SELECT version FROM schema_version")).toEqual({ version: 4 });
		expect(upgraded.all("SELECT key,value FROM app_settings WHERE key!='autoDownloadUpdates' ORDER BY key")).toEqual(
			retained,
		);
		expect(upgraded.get("SELECT * FROM drafts WHERE key='retained'")).toEqual({
			key: "retained",
			payload: '{"text":"unsent"}',
			revision: 7,
			updated_at: 11,
		});
		await reopened.updateAppSettings({ type: "autoDownloadUpdates", enabled: false });
		await reopened.dispose();
		upgraded.dispose();
		const restarted = createAppSettingsStore({ userDataDir, database: database(userDataDir) });
		stores.push(restarted);
		expect(restarted.getAppSettings().autoDownloadUpdates).toBe(false);
	});

	it.each(["missing current value", "invalid historical value"])("keeps %s visible as corruption", async (scenario) => {
		const { store, userDataDir, db } = await createStore();
		store.getAppSettings();
		if (scenario === "missing current value") {
			db.run("DELETE FROM app_settings WHERE key='autoDownloadUpdates'");
		} else {
			db.run("UPDATE schema_version SET version=3");
			db.run("UPDATE app_settings SET value='\"disabled\"' WHERE key='autoDownloadUpdates'");
		}
		await store.dispose();
		db.dispose();
		const reopened = createAppSettingsStore({ userDataDir, database: database(userDataDir) });
		stores.push(reopened);
		expect(reopened.readAppSettings().status).toBe("recoveryRequired");
	});

	it("defaults automatic downloads on for version 6 and persists an explicit choice", async () => {
		const { store, userDataDir } = await createStore();
		await writeFile(
			join(userDataDir, "settings.json"),
			JSON.stringify({
				schema: "ling/app-settings",
				version: 6,
				writtenAt: 1,
				data: {
					keepRunningOnWindowClose: true,
					disableHardwareAcceleration: false,
					notifyBackgroundCompletion: true,
					notifyAttentionNeeded: false,
					playNotificationSounds: false,
					projectLaunchers: { editor: null, terminal: null, "file-manager": null },
					integratedTerminalProfileId: null,
					fileMentionsRespectGitignore: true,
					keepAwakeWhileRunning: true,
				},
			}),
		);
		expect(store.readAppSettings()).toMatchObject({
			status: "ready",
			settings: {
				autoDownloadUpdates: true,
				keepRunningOnWindowClose: true,
				notifyAttentionNeeded: false,
			},
		});
		await store.updateAppSettings({ type: "autoDownloadUpdates", enabled: false });
		await store.dispose();
		const reopened = createAppSettingsStore({ userDataDir, database: database(userDataDir) });
		stores.push(reopened);
		expect(reopened.readAppSettings()).toMatchObject({
			status: "ready",
			settings: {
				autoDownloadUpdates: false,
				keepRunningOnWindowClose: true,
				notifyAttentionNeeded: false,
			},
		});
	});
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
