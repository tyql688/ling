import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiAdapterPlan } from "./adapter-plan";
import { resolvePiPackageEntry } from "./package-entry";
import * as packageEntries from "./package-entry";
import { createAccessActivation } from "./permission-system/activation";
import { createBuiltinFeatures } from "../companions/builtin-features";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retains the requested protection when the bundled permission package cannot be resolved", async () => {
	const home = await temporaryDirectory("missing-permission-package");
	roots.push(home);
	const activation = createAccessActivation(home);
	await activation.write({ expectedRevision: 0, defaultEnabled: true }, new AbortController().signal);
	const resolveEntry = packageEntries.resolvePiPackageEntry;
	vi.spyOn(packageEntries, "resolvePiPackageEntry").mockImplementation((name, entry) =>
		name === "@gotgenes/pi-permission-system"
			? Promise.reject(new Error("Package unavailable"))
			: resolveEntry(name, entry),
	);
	const plan = createPiAdapterPlan(activation, createBuiltinFeatures(home));
	expect((await plan.read(join(home, "project"))).permissions).toEqual({ entry: null, enabled: true });
});

it("resolves both bundled packages, including one with a restrictive exports map", async () => {
	expect(await resolvePiPackageEntry("@juicesharp/rpiv-todo", "index.ts")).toMatch(/rpiv-todo[/\\]index\.ts$/);
	expect(await resolvePiPackageEntry("@gotgenes/pi-permission-system", "src/index.ts")).toMatch(
		/pi-permission-system[/\\]src[/\\]index\.ts$/,
	);
	await expect(resolvePiPackageEntry("@juicesharp/rpiv-todo", "missing.ts")).rejects.toThrow("does not declare");
});

it("applies project access choices and keeps the permission system on when they are unreadable", async () => {
	const home = await temporaryDirectory("adapter-plan");
	roots.push(home);
	const activation = createAccessActivation(home);
	const features = createBuiltinFeatures(home);
	const plan = createPiAdapterPlan(activation, features);
	const cwd = join(home, "project");
	expect(await plan.read(cwd)).toMatchObject({ todo: expect.any(String), permissions: { enabled: false } });
	await activation.write({ expectedRevision: 0, project: { cwd, enabled: true } }, new AbortController().signal);
	expect((await plan.read(cwd)).permissions?.enabled).toBe(true);
	await features.write({ id: "permissions", enabled: false, expectedRevision: 0 }, new AbortController().signal);
	expect((await plan.read(cwd)).permissions?.enabled).toBe(false);
	expect((await activation.read()).projects[cwd]).toBe(true);
	await features.write({ id: "permissions", enabled: true, expectedRevision: 1 }, new AbortController().signal);
	expect((await plan.read(cwd)).permissions?.enabled).toBe(true);
	await features.write({ id: "todo", enabled: false, expectedRevision: 2 }, new AbortController().signal);
	expect((await plan.read(cwd)).todo).toBeNull();
	expect((await plan.read(join(home, "other"))).permissions?.enabled).toBe(false);
	const file = join(home, "plugin-data", "ling-permission-system", "pi-activation.json");
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, "{broken");
	expect((await plan.read(join(home, "other"))).permissions?.enabled).toBe(true);
});
