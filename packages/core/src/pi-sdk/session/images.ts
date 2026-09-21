import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
	type ImageAttachment,
	SESSION_IMAGE_SEND_BASE64_MAX_CHARS,
	sessionImageMimeTypeSchema,
} from "@ling/contracts/session";

/**
 * Downscale oversized attachments before they reach the provider so a large
 * paste is not silently dropped. Only images above {@link SESSION_IMAGE_SEND_BASE64_MAX_CHARS}
 * are decoded and resized (SDK `resizeImage`: Photon/WASM, 2000px, 4.5MB base64).
 * `resizeImage` returns null when an image cannot be decoded or cannot be
 * compressed below the ceiling — we fail fast with a visible error rather than
 * sending something the provider will silently reject.
 */
export async function resizeImageAttachmentsForSend(images: readonly ImageAttachment[]): Promise<ImageAttachment[]> {
	const prepared: ImageAttachment[] = [];
	for (const image of images) {
		if (image.data.length <= SESSION_IMAGE_SEND_BASE64_MAX_CHARS) {
			prepared.push(image);
			continue;
		}
		const result = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType);
		if (!result) {
			const megabytes = Math.round(image.data.length / 1024 / 1024);
			throw new Error(`Image is too large to send and could not be compressed (${image.mimeType}, ~${megabytes}MB).`);
		}
		prepared.push({ type: "image", data: result.data, mimeType: sessionImageMimeTypeSchema.parse(result.mimeType) });
	}
	return prepared;
}
