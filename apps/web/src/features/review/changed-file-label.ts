import type { ChangeReviewFile } from "@ling/contracts/git";
import { tildify } from "@renderer/lib/format-path";

export function splitChangedPath(path: string): { directory: string; name: string } {
	const normalized = tildify(path);
	const separatorIndex = normalized.lastIndexOf("/");
	if (separatorIndex === -1) return { directory: "", name: normalized };
	return { directory: normalized.slice(0, separatorIndex), name: normalized.slice(separatorIndex + 1) };
}

export function changedFileLabel(file: Pick<ChangeReviewFile, "path" | "from">): string {
	return file.from ? `${tildify(file.from)} -> ${tildify(file.path)}` : tildify(file.path);
}
