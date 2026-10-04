import type { SessionImageSource } from "@ling/contracts/session-messages";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionImageUrl } from "@ling/contracts/markdown-image-url";
import { useMemo } from "react";
import { useSessionImageRef } from "./session-image-source";

interface ImageBearingPart {
	type: string;
	data?: string;
	mimeType?: string;
	source?: SessionImageSource;
}

export interface MessageImage {
	/** An authenticated `/api/media/attachment` URL, or a data URL while the message is not persisted yet. */
	src: string;
}

/** Fetches persisted image bytes through the attachment protocol. Messages carry inline bytes until persistence completes. */
function imageSource(part: ImageBearingPart, ref: SessionRef | null): MessageImage | null {
	if (part.type !== "image" || typeof part.mimeType !== "string") return null;
	if (part.source && ref) return { src: sessionImageUrl(ref, part.source) };
	if (typeof part.data === "string") return { src: `data:${part.mimeType};base64,${part.data}` };
	return null;
}

/** Pure form, for render paths that reach the message behind a branch and cannot call a hook. */
export function resolveMessageImages(
	content: string | readonly ImageBearingPart[],
	ref: SessionRef | null,
): MessageImage[] {
	if (typeof content === "string") return [];
	return content.map((part) => imageSource(part, ref)).filter((image): image is MessageImage => image !== null);
}

export function useMessageImages(content: string | readonly ImageBearingPart[]): MessageImage[] {
	const ref = useSessionImageRef();
	return useMemo(() => resolveMessageImages(content, ref), [content, ref]);
}
