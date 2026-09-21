import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../test/temporary-directory";
import { restoreReviewTextSides } from "./change-review-context";

describe("saved review context", () => {
	it.each(["\n", "\r\n"])(
		"recovers both sides of a Git patch with %j line endings and refuses later edits",
		async (eol) => {
			const cwd = await temporaryDirectory("review-context");
			try {
				const git = (...args: string[]) =>
					execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				git("init", "--quiet");
				git("config", "core.autocrlf", "false");
				const original = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join(eol) + eol;
				const modified = original
					.replace(`line 10${eol}`, `changed 10${eol}`)
					.replace(`line 65${eol}`, `changed 65${eol}`);
				await writeFile(join(cwd, "example.txt"), original);
				git("add", "example.txt");
				await writeFile(join(cwd, "example.txt"), modified);
				const patch = git("diff", "--no-ext-diff", "--no-textconv", "--binary", "--", "example.txt");
				expect(restoreReviewTextSides(patch, modified)).toEqual({ original, modified });
				expect(restoreReviewTextSides(patch, original)).toEqual({ original, modified });
				// Changed omitted context must never be presented as historical text, even when every hunk still applies.
				expect(restoreReviewTextSides(patch, modified.replace("line 40", "later edit"))).toBeNull();
				expect(restoreReviewTextSides(patch.replace("+changed 10", "+incorrect 10"), original)).toBeNull();
				expect(restoreReviewTextSides(patch.replace(/^index .*\n/m, ""), modified)).toBeNull();
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
	);
});
