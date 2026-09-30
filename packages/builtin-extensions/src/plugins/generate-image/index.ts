import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Image requests share the session's provider registrations, credentials and cancellation. */
export function createImageGenerationExtension(runtime: ModelRuntime): (pi: ExtensionAPI) => void {
	return (pi) =>
		pi.registerTool({
			name: "generate_image",
			label: "Generate image",
			// Image results belong directly to the transcript, including in Codemode-only loadouts.
			exposure: "model-only",
			description:
				"List available image-generation models or generate/edit images with Pi. Use action=list to discover configured providers and model IDs, then action=generate with provider, model and prompt. Optional referenceImages are project image paths read through the read tool and its permission checks. Generated images are displayed and saved in the session; they can be previewed and downloaded. Only generate when the user requests images.",
			promptSnippet: "Discover image models and generate or edit images directly in the conversation.",
			parameters: Type.Object({
				action: Type.String({ enum: ["list", "generate"] }),
				provider: Type.Optional(Type.String({ minLength: 1 })),
				model: Type.Optional(Type.String({ minLength: 1 })),
				prompt: Type.Optional(Type.String({ minLength: 1 })),
				// Limit one request's reference fan-out while preserving normal multi-image editing.
				referenceImages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				if (params.action === "list") {
					const models = await runtime.getAvailableOfType("image", params.provider, signal ? { signal } : undefined);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									models.map(({ provider, id, name, input, output }) => ({ provider, id, name, input, output })),
								),
							},
						],
						details: undefined,
					};
				}
				if (!params.provider || !params.model || !params.prompt?.trim())
					throw new Error("Image generation requires provider, model and prompt.");
				const model = runtime.getModelOfType("image", params.provider, params.model);
				if (!model)
					throw new Error(
						`Unknown image model: ${params.provider}/${params.model}. Use action=list to discover image models.`,
					);
				const input: Parameters<ModelRuntime["generateImages"]>[1]["input"] = [{ type: "text", text: params.prompt }];
				for (const path of params.referenceImages ?? []) {
					signal?.throwIfAborted();
					const reference = await ctx.executeTool("read", { path });
					// Pi adds nested usage to the parent result independently of its displayed content.
					if (reference.isError) return { content: reference.result.content, isError: true, details: undefined };
					const images = reference.result.content.filter((part) => part.type === "image");
					if (images.length === 0) throw new Error(`Reference did not contain a readable image: ${path}`);
					input.push(...images);
				}
				const result = await runtime.generateImages(model, { input }, signal ? { signal } : undefined);
				const failed = result.stopReason !== "stop";
				return {
					content: [
						...result.output,
						...(failed
							? [{ type: "text" as const, text: result.errorMessage ?? `Image generation ${result.stopReason}.` }]
							: []),
					],
					details: { provider: result.provider, model: result.model },
					...(result.usage ? { usage: result.usage } : {}),
					isError: failed,
				};
			},
		});
}
