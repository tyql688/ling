import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { ImageAttachment } from "@ling/contracts/session";
import type { PiAgentSession } from "../types";

/** Pi 0.87 normalizes prompt images but not steer/followUp images. Reuse its public
 * read tool's image processing with in-memory bytes and the same model/settings. */
export async function prepareQueuedImages(
	session: Pick<PiAgentSession, "model" | "settingsManager" | "sessionManager">,
	images: readonly ImageAttachment[] | undefined,
): Promise<ImageAttachment[] | undefined> {
	if (!images?.length) return images === undefined ? undefined : [];
	const prepared: ImageAttachment[] = [];
	for (const image of images) {
		const tool = createReadTool(session.sessionManager.getCwd(), {
			autoResizeImages: session.settingsManager.getImageAutoResize(),
			...(session.model?.inputLimits?.images?.resize ? { resizeOptions: session.model.inputLimits.images.resize } : {}),
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from(image.data, "base64"),
				detectImageMimeType: async () => image.mimeType,
			},
		});
		const result = await tool.execute("queued-image", { path: "attachment" });
		const converted = result.content.find((part) => part.type === "image");
		if (!converted) {
			throw new Error(result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
		}
		prepared.push(converted);
	}
	return prepared;
}
