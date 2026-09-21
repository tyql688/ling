import type { ChangeReviewFile } from "@ling/contracts/git";
import { tildify } from "@renderer/lib/format-path";

export function changedFileLabel(file: Pick<ChangeReviewFile, "path" | "from">): string {
	return file.from ? `${tildify(file.from)} -> ${tildify(file.path)}` : tildify(file.path);
}
