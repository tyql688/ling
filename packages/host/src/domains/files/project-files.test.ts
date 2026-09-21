import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { PROJECT_DIRECTORY_MAX_ENTRIES } from "@ling/contracts/project";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import {
	browseHostDirectories,
	listProjectDirectory,
	readProjectFilePreview,
	createProjectFileWriter,
} from "./project-files";

it("browses unopened Host folders with absolute choices and preserves directory read failures", async () => {
	const root = await temporaryDirectory("host-folder-picker");
	try {
		await mkdir(join(root, "project"));
		await writeFile(join(root, "private.txt"), "Not a folder choice");
		const canonical = await realpath(root);
		expect(await browseHostDirectories(root)).toEqual({
			path: canonical,
			parent: dirname(canonical),
			entries: [{ name: "project", path: join(canonical, "project"), unavailable: false }],
			truncated: false,
		});
		expect(await browseHostDirectories(join(root, "project"))).toMatchObject({ parent: canonical, entries: [] });
		await expect(browseHostDirectories(join(root, "missing"))).rejects.toMatchObject({
			code: "HOST_DIRECTORY_UNAVAILABLE",
			lingError: { details: { systemCode: "ENOENT" } },
		});
		await expect(browseHostDirectories(join(root, "private.txt"))).rejects.toMatchObject({
			code: "HOST_DIRECTORY_UNAVAILABLE",
			lingError: { details: { systemCode: "ENOTDIR" } },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")("keeps broken folder links visible while resolving usable links", async () => {
	const root = await temporaryDirectory("host-folder-links");
	try {
		await mkdir(join(root, "target"));
		await symlink("target", join(root, "alias"));
		await symlink("missing", join(root, "broken"));
		const canonical = await realpath(root);
		expect((await browseHostDirectories(root)).entries).toEqual([
			{ name: "alias", path: join(canonical, "alias"), unavailable: false },
			{ name: "target", path: join(canonical, "target"), unavailable: false },
			{ name: "broken", path: join(canonical, "broken"), unavailable: true },
		]);
		expect((await browseHostDirectories(join(root, "alias"))).path).toBe(join(canonical, "target"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("reports a bounded Host folder list without treating omitted entries as absent", async () => {
	const root = await temporaryDirectory("host-folder-bound");
	try {
		for (let index = 0; index <= PROJECT_DIRECTORY_MAX_ENTRIES; index++) await mkdir(join(root, String(index)));
		const listing = await browseHostDirectories(root);
		expect(listing.truncated).toBe(true);
		expect(listing.entries).toHaveLength(PROJECT_DIRECTORY_MAX_ENTRIES);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("allows only one concurrent file save for the same disk revision", async () => {
	const root = await temporaryDirectory("project-file-save");
	const writeProjectFile = createProjectFileWriter();
	try {
		await writeFile(join(root, "notes.txt"), "Original");
		const preview = await readProjectFilePreview(root, "notes.txt");
		if (preview.kind !== "text") throw new Error("Expected a text fixture");
		const results = await Promise.allSettled(
			Array.from({ length: 16 }, (_, index) => writeProjectFile(root, "notes.txt", `Saved ${index}`, preview.revision)),
		);
		const successful = results.flatMap((result, index) => (result.status === "fulfilled" ? [index] : []));
		expect(successful).toHaveLength(1);
		expect(await readFile(join(root, "notes.txt"), "utf8")).toBe(`Saved ${successful[0]}`);
		for (const result of results)
			if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "STALE_STATE_REVISION" });
		const refreshed = await readProjectFilePreview(root, "notes.txt");
		if (refreshed.kind !== "text") throw new Error("Expected the saved text fixture");
		await writeProjectFile(root, "notes.txt", "Saved after conflict", refreshed.revision);
		expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("Saved after conflict");
		expect(await readdir(root)).toEqual(["notes.txt"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")("serializes symlink aliases through the same save owner", async () => {
	const root = await temporaryDirectory("project-file-alias");
	const writeProjectFile = createProjectFileWriter();
	try {
		await writeFile(join(root, "notes.txt"), "Original");
		await symlink("notes.txt", join(root, "alias.txt"));
		const preview = await readProjectFilePreview(root, "notes.txt");
		if (preview.kind !== "text") throw new Error("Expected a text fixture");
		const results = await Promise.allSettled([
			writeProjectFile(root, "notes.txt", "First save", preview.revision),
			writeProjectFile(root, "alias.txt", "Second save", preview.revision),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			reason: { code: "STALE_STATE_REVISION" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("reports a deleted project folder as a missing directory rather than an internal read failure", async () => {
	const root = await temporaryDirectory("project-directory-missing");
	await writeFile(join(root, "notes.txt"), "Original");
	await rm(root, { recursive: true, force: true });
	// Build each call inside its own await; a pre-created rejected promise would go unhandled.
	for (const operation of [() => listProjectDirectory(root, ""), () => readProjectFilePreview(root, "notes.txt")]) {
		await expect(operation()).rejects.toMatchObject({ code: "PROJECT_DIRECTORY_MISSING" });
	}
});
