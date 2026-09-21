import type { CustomSessionMessage, RenderedCustomSessionMessage } from "@ling/contracts/session-messages";
import { toCommandError } from "../../command-resolver";
import type { PiAgentSession, PiBranchProjectionSource } from "../types";
import { EXTENSION_UI_RENDER_WIDTH } from "./extension-ui-overlay-layout";
import { isPiRenderableComponent, renderPiComponentLines } from "./extension-ui-renderable";
import { lingWidgetTheme } from "./extension-ui-theme";

type PiMessageRenderer = NonNullable<ReturnType<PiAgentSession["extensionRunner"]["getMessageRenderer"]>>;
type PiCustomMessageForRenderer = Parameters<PiMessageRenderer>[0];
type PiEntryRenderer = NonNullable<ReturnType<PiAgentSession["extensionRunner"]["getEntryRenderer"]>>;
type PiCustomEntryForRenderer = Parameters<PiEntryRenderer>[0];

function renderVariant(
	renderer: PiMessageRenderer,
	message: CustomSessionMessage,
	expanded: boolean,
	outputPad: number,
): string[] | undefined {
	const component = renderer(message as PiCustomMessageForRenderer, { expanded, outputPad }, lingWidgetTheme);
	if (component === undefined) return undefined;
	if (!isPiRenderableComponent(component)) {
		throw new Error(`Extension message renderer for ${message.customType} returned an invalid component`);
	}
	return renderPiComponentLines(
		component,
		EXTENSION_UI_RENDER_WIDTH,
		() => new Error(`Extension message renderer for ${message.customType} returned invalid lines`),
	);
}

export function renderPiCustomMessage(
	extensions: PiBranchProjectionSource["extensions"],
	message: CustomSessionMessage,
): RenderedCustomSessionMessage | undefined {
	const renderer = extensions?.extensionRunner.getMessageRenderer(message.customType);
	if (!renderer || !extensions) return undefined;
	try {
		const outputPad = extensions.settingsManager.getOutputPad();
		const collapsedLines = renderVariant(renderer, message, false, outputPad);
		const expandedLines = renderVariant(renderer, message, true, outputPad);
		if (collapsedLines === undefined && expandedLines === undefined) return undefined;
		return {
			...(collapsedLines === undefined ? {} : { collapsedLines }),
			...(expandedLines === undefined ? {} : { expandedLines }),
		};
	} catch (error) {
		const normalized = toCommandError(error);
		return { error: normalized.message };
	}
}

function renderEntryVariant(
	renderer: PiEntryRenderer,
	entry: PiCustomEntryForRenderer,
	expanded: boolean,
): string[] | undefined {
	const component = renderer(entry, { expanded }, lingWidgetTheme);
	if (component === undefined) return undefined;
	if (!isPiRenderableComponent(component)) {
		throw new Error(`Extension entry renderer for ${entry.customType} returned an invalid component`);
	}
	return renderPiComponentLines(
		component,
		EXTENSION_UI_RENDER_WIDTH,
		() => new Error(`Extension entry renderer for ${entry.customType} returned invalid lines`),
	);
}

export function renderPiCustomEntry(
	extensions: PiBranchProjectionSource["extensions"],
	entry: PiCustomEntryForRenderer,
): RenderedCustomSessionMessage | undefined {
	const renderer = extensions?.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) return undefined;
	try {
		const collapsedLines = renderEntryVariant(renderer, entry, false);
		const expandedLines = renderEntryVariant(renderer, entry, true);
		if (collapsedLines === undefined && expandedLines === undefined) return undefined;
		return {
			...(collapsedLines === undefined ? {} : { collapsedLines }),
			...(expandedLines === undefined ? {} : { expandedLines }),
		};
	} catch (error) {
		const normalized = toCommandError(error);
		return { error: normalized.message };
	}
}
