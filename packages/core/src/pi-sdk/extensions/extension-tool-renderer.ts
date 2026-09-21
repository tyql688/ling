import { record } from "@ling/contracts/records";
import type { RenderedTextSnapshot } from "@ling/contracts/session";
import { toCommandError } from "../../command-resolver";
import type { PiAgentSession, PiBranchProjectionSource } from "../types";
import { EXTENSION_UI_RENDER_WIDTH } from "./extension-ui-overlay-layout";
import { isPiRenderableComponent, renderPiComponentLines } from "./extension-ui-renderable";
import { lingWidgetTheme } from "./extension-ui-theme";
import { createPiToolOrigins } from "./pi-tool-origin";

type PiToolDefinition = NonNullable<ReturnType<PiAgentSession["extensionRunner"]["getToolDefinition"]>>;
type PiRenderCall = NonNullable<PiToolDefinition["renderCall"]>;
type PiRenderResult = NonNullable<PiToolDefinition["renderResult"]>;
type PiRenderContext = Parameters<PiRenderCall>[2];
type PiToolResult = Parameters<PiRenderResult>[0];

interface TrackedToolCall {
	name: string;
	args: Record<string, unknown>;
	cwd: string;
}

/** A normal turn has only a handful of calls; malformed/missing results must not retain every args object. */
const MAX_PENDING_TOOL_RENDERER_CALLS = 128;

function renderContext(
	call: TrackedToolCall,
	toolCallId: string,
	expanded: boolean,
	state: Record<string, unknown>,
	isError: boolean,
	isPartial = false,
): PiRenderContext {
	return {
		args: call.args,
		toolCallId,
		invalidate: () => {},
		lastComponent: undefined,
		state,
		cwd: call.cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial,
		expanded,
		showImages: false,
		isError,
	};
}

function renderLines(component: unknown, toolName: string): string[] {
	if (!isPiRenderableComponent(component))
		throw new Error(`Tool renderer for ${toolName} returned an invalid component`);
	try {
		return renderPiComponentLines(
			component,
			EXTENSION_UI_RENDER_WIDTH,
			() => new Error(`Tool renderer for ${toolName} returned invalid lines`),
		);
	} finally {
		component.dispose?.();
	}
}

function renderCallVariant(
	renderer: PiRenderCall,
	call: TrackedToolCall,
	toolCallId: string,
	expanded: boolean,
	state: Record<string, unknown>,
): string[] {
	return renderLines(
		renderer(call.args, lingWidgetTheme, renderContext(call, toolCallId, expanded, state, false)),
		call.name,
	);
}

function renderResultVariant(
	definition: PiToolDefinition,
	call: TrackedToolCall,
	toolCallId: string,
	result: PiToolResult,
	expanded: boolean,
	isError: boolean,
	isPartial = false,
): string[] {
	const state: Record<string, unknown> = {};
	if (definition.renderCall) renderCallVariant(definition.renderCall, call, toolCallId, expanded, state);
	const renderer = definition.renderResult;
	if (!renderer) return [];
	return renderLines(
		renderer(
			result,
			{ expanded, isPartial },
			lingWidgetTheme,
			renderContext(call, toolCallId, expanded, state, isError, isPartial),
		),
		call.name,
	);
}

function renderCallSnapshot(
	definition: PiToolDefinition,
	call: TrackedToolCall,
	toolCallId: string,
): RenderedTextSnapshot | undefined {
	if (!definition.renderCall) return undefined;
	try {
		return {
			collapsedLines: renderCallVariant(definition.renderCall, call, toolCallId, false, {}),
			expandedLines: renderCallVariant(definition.renderCall, call, toolCallId, true, {}),
		};
	} catch (error) {
		return { error: toCommandError(error).message };
	}
}

function renderResultSnapshot(
	definition: PiToolDefinition,
	call: TrackedToolCall,
	toolCallId: string,
	result: unknown,
	isError: boolean,
	isPartial = false,
): RenderedTextSnapshot | undefined {
	if (!definition.renderResult) return undefined;
	try {
		return {
			collapsedLines: renderResultVariant(
				definition,
				call,
				toolCallId,
				result as PiToolResult,
				false,
				isError,
				isPartial,
			),
			expandedLines: renderResultVariant(
				definition,
				call,
				toolCallId,
				result as PiToolResult,
				true,
				isError,
				isPartial,
			),
		};
	} catch (error) {
		return { error: toCommandError(error).message };
	}
}

/** One projection instance preserves call arguments until the matching result appears. */
export function createPiToolRendererProjection(owner: PiBranchProjectionSource) {
	const originFor = createPiToolOrigins(owner.sessionManager);
	const calls = new Map<string, TrackedToolCall>();
	const rememberCall = (toolCallId: string, call: TrackedToolCall): void => {
		calls.delete(toolCallId);
		calls.set(toolCallId, call);
		while (calls.size > MAX_PENDING_TOOL_RENDERER_CALLS) {
			const oldest = calls.keys().next().value;
			if (oldest === undefined) break;
			calls.delete(oldest);
		}
	};
	return {
		project(value: unknown, final = false, deferResult = false, entryId: string | null = null): unknown {
			const source = record(value);
			if (source?.role === "assistant" && Array.isArray(source.content)) {
				let changed = false;
				const content = source.content.map((candidate) => {
					const part = record(candidate);
					if (part?.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") {
						return candidate;
					}
					const call = { name: part.name, args: record(part.arguments) ?? {}, cwd: owner.sessionManager.getCwd() };
					rememberCall(part.id, call);
					const definition = owner.extensions?.extensionRunner.getToolDefinition(part.name);
					if (!definition) return candidate;
					const rendered = renderCallSnapshot(definition, call, part.id);
					if (!rendered) return candidate;
					changed = true;
					return { ...part, rendered };
				});
				return changed ? { ...source, content } : value;
			}
			if (
				source?.role === "toolResult" &&
				typeof source.toolCallId === "string" &&
				typeof source.toolName === "string" &&
				typeof source.isError === "boolean"
			) {
				const toolOrigin = originFor(source.toolCallId, entryId);
				const result = toolOrigin ? { ...source, toolOrigin } : source;
				const call = calls.get(source.toolCallId);
				if (final) calls.delete(source.toolCallId);
				if (deferResult) {
					return { ...result, content: [], details: undefined, rendered: undefined, contentState: "deferred" };
				}
				const definition = owner.extensions?.extensionRunner.getToolDefinition(source.toolName);
				if (!call || call.name !== source.toolName || !definition) return result;
				const rendered = renderResultSnapshot(definition, call, source.toolCallId, source, source.isError);
				return rendered ? { ...result, rendered } : result;
			}
			return value;
		},
		projectPartial(toolCallId: string, result: unknown): RenderedTextSnapshot | undefined {
			const call = calls.get(toolCallId);
			if (!call) return undefined;
			const definition = owner.extensions?.extensionRunner.getToolDefinition(call.name);
			return definition ? renderResultSnapshot(definition, call, toolCallId, result, false, true) : undefined;
		},
		clear(): void {
			calls.clear();
		},
	};
}
