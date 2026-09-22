import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { prepareQueuedImages } from "./queued-images";
import type { PiAgentSession } from "../types";

const image = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFoQAAAAASUVORK5CYII=",
};
function session(autoResize: boolean, maxBytes: number) {
	const model: NonNullable<PiAgentSession["model"]> = {
		id: "test",
		name: "test",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		inputLimits: { images: { resize: { maxBytes } } },
	};
	return {
		model,
		settingsManager: SettingsManager.inMemory({ images: { autoResize } }),
		sessionManager: SessionManager.inMemory(process.cwd()),
	};
}

it("respects Pi's disabled resizing even when the model's inline limit is smaller", async () => {
	expect(await prepareQueuedImages(session(false, 4), [image])).toEqual([image]);
});

it("uses Pi's selected model profile for queued images and preserves the input on failure", async () => {
	await expect(prepareQueuedImages(session(true, 4), [image])).rejects.toThrow();
	expect(image.mimeType).toBe("image/png");
	expect(await prepareQueuedImages(session(false, 4), undefined)).toBeUndefined();
});
