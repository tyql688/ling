import { errorMessage } from "@ling/contracts/ling-error";
import { parseDiffFromFile } from "@pierre/diffs";
import type { ReviewDiffRequest, ReviewDiffResult } from "./review-diff-worker";

self.onmessage = ({ data }: MessageEvent<ReviewDiffRequest>) => {
	let result: ReviewDiffResult;
	try {
		const fileDiff = parseDiffFromFile(
			{ name: data.path, contents: data.original, lang: data.lang, cacheKey: `${data.id}:old` },
			{ name: data.path, contents: data.modified, lang: data.lang, cacheKey: `${data.id}:new` },
			// Git can normalize Windows checkout line endings without changing any source lines.
			{ context: 3, stripTrailingCr: true },
			true,
		);
		result = { status: "ok", fileDiff };
	} catch (cause) {
		result = { status: "error", message: errorMessage(cause) };
	}
	self.postMessage(result);
};
