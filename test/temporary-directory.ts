import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

const root = join(
	resolve(process.env.LING_DEV_ROOT ?? join(homedir(), ".cache/ling-dev")),
	"tests",
	String(process.pid),
);

/** Tests own child cleanup after their resources drain; a shared empty parent leaves no debris. */
export async function temporaryDirectory(owner: string): Promise<string> {
	for (;;) {
		await mkdir(root, { recursive: true });
		try {
			return await mkdtemp(join(root, `${owner}-`));
		} catch (error) {
			// Another suite may remove the empty shared parent between mkdir and mkdtemp.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

afterAll(async () => {
	try {
		await rmdir(root);
	} catch (error) {
		// Parallel suites still own their directories; the last suite removes the parent.
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
});
