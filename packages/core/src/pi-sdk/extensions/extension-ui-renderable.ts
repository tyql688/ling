import {
	EXTENSION_UI_RENDERED_LINE_MAX_ITEMS,
	EXTENSION_UI_TEXT_MAX_CHARS,
} from "@ling/contracts/session-extension-ui";

interface PiRenderableComponent {
	render(width: number): unknown;
	dispose?(): void;
}

export interface PiWidgetComponent extends PiRenderableComponent {
	render(width: number): string[];
	invalidate(): void;
}

export function isPiRenderableComponent(value: unknown): value is PiRenderableComponent {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

export function isPiWidgetComponent(value: unknown): value is PiWidgetComponent {
	return isPiRenderableComponent(value) && "invalidate" in value && typeof value.invalidate === "function";
}

export function assertPiRenderedLines(value: unknown, createError: () => Error): asserts value is string[] {
	if (!Array.isArray(value) || value.length > EXTENSION_UI_RENDERED_LINE_MAX_ITEMS) {
		throw createError();
	}
	let totalChars = 0;
	for (const line of value) {
		if (typeof line !== "string") throw createError();
		totalChars += line.length;
		if (totalChars > EXTENSION_UI_TEXT_MAX_CHARS) throw createError();
	}
}

export function renderPiComponentLines(
	component: PiRenderableComponent,
	width: number,
	createError: () => Error,
): string[] {
	const lines = component.render(width);
	assertPiRenderedLines(lines, createError);
	return lines;
}
