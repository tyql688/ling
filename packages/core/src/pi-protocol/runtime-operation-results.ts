import { z } from "zod";
import {
	EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_MAX_ITEMS,
	EXTENSION_UI_INPUT_MAX_CHARS,
	THINKING_LEVELS,
} from "@ling/contracts/session";
import {
	fieldSchema,
	countSchema,
	idSchema,
	runtimeStateSchema,
	COLLECTION_MAX_ITEMS,
	thinkingLevelSchema,
} from "./runtime-payload-schemas";
const extensionUiInputSchema = z.string().max(EXTENSION_UI_INPUT_MAX_CHARS);
const autocompleteItemSchema = z.strictObject({
	value: extensionUiInputSchema,
	label: z.string().max(EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS),
	description: z.string().max(EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS).optional(),
});
export const autocompleteSuggestionsSchema = z.strictObject({
	items: z.array(autocompleteItemSchema).max(EXTENSION_AUTOCOMPLETE_MAX_ITEMS),
	prefix: extensionUiInputSchema,
});
export const modelStateSchema = z.strictObject({
	models: z
		.array(
			z.strictObject({
				provider: fieldSchema,
				providerName: fieldSchema,
				id: fieldSchema,
				name: fieldSchema,
				reasoning: z.boolean(),
				availableThinkingLevels: z.array(thinkingLevelSchema).max(THINKING_LEVELS.length),
				contextWindow: countSchema,
			}),
		)
		.max(COLLECTION_MAX_ITEMS),
	currentProvider: fieldSchema.optional(),
	currentModelId: fieldSchema.optional(),
	thinkingLevel: thinkingLevelSchema,
	availableThinkingLevels: z.array(thinkingLevelSchema).max(THINKING_LEVELS.length),
});

export const runtimeBootstrapSchema = z.strictObject({ runtimeId: idSchema, state: runtimeStateSchema });
