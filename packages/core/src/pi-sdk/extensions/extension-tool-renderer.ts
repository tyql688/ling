import { record } from "@ling/contracts/records";
import { toolDurationMsSchema, type RenderedTextSnapshot } from "@ling/contracts/session-messages";
import { toCommandError } from "../../command-resolver";
import type { PiAgentSession, PiBranchProjectionSource } from "../types";
import { EXTENSION_UI_RENDER_WIDTH } from "./extension-ui-overlay-layout";
import { isPiRenderableComponent, renderPiComponentLines } from "./extension-ui-renderable";
import { lingWidgetTheme } from "./extension-ui-theme";
import { createPiToolOrigins } from "./pi-tool-origin";

type PiToolDefinition = NonNullable<ReturnType<PiAgentSession["extensionRunner"]["resolveToolRenderers"]>>;
type PiRenderCall = NonNullable<PiToolDefinition["renderCall"]>;
type PiRenderResult = NonNullable<PiToolDefinition["renderResult"]>;
type PiRenderContext = Parameters<PiRenderCall>[2];
type PiToolResult = Parameters<PiRenderResult>[0];

interface TrackedToolCall {
	name: string;
	args: Record<string, unknown>;
	cwd: string;
	outputPad: number;
}

/** A normal turn has only a handful of calls; malformed/missing results must not retain every args object. */
const MAX_PENDING_TOOL_RENDERER_CALLS = 128;

export function hasPiToolRenderers(session: PiAgentSession): boolean {
	return session.resourceLoader
		.getExtensions()
		.extensions.some(
			(extension) =>
				Boolean(extension.toolRenderers?.length) ||
				[...extension.tools.values()].some(({ definition }) => definition.renderCall || definition.renderResult),
		);
}

function renderContext(
	call: TrackedToolCall,
	toolCallId: string,
	expanded: boolean,
	state: Record<string, unknown>,
	isError: boolean,
	isPartial = false,
	durationMs?: number,
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
		durationMs,
		outputPad: call.outputPad,
	};
}

function renderLines(component: unknown, toolName: string, width: number): string[] {
	if (!isPiRenderableComponent(component))
		throw new Error(`Tool renderer for ${toolName} returned an invalid component`);
	try {
		return renderPiComponentLines(
			component,
			width,
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
	width: number,
	durationMs?: number,
): string[] {
	return renderLines(
		renderer(call.args, lingWidgetTheme, renderContext(call, toolCallId, expanded, state, false, false, durationMs)),
		call.name,
		width,
	);
}

function renderResultVariant(
	definition: PiToolDefinition,
	call: TrackedToolCall,
	toolCallId: string,
	result: PiToolResult,
	expanded: boolean,
	isError: boolean,
	width: number,
	isPartial = false,
): string[] {
	const state: Record<string, unknown> = {};
	const recordedDuration = record(result)?.durationMs;
	const durationMs =
		isPartial || recordedDuration === undefined ? undefined : toolDurationMsSchema.parse(recordedDuration);
	if (definition.renderCall)
		renderCallVariant(definition.renderCall, call, toolCallId, expanded, state, width, durationMs);
	const renderer = definition.renderResult;
	if (!renderer) return [];
	return renderLines(
		renderer(
			result,
			{ expanded, isPartial },
			lingWidgetTheme,
			renderContext(call, toolCallId, expanded, state, isError, isPartial, durationMs),
		),
		call.name,
		width,
	);
}

function resolveToolRenderers(owner: PiBranchProjectionSource, name: string): PiToolDefinition | undefined {
	const runner = owner.extensions?.extensionRunner;
	return runner?.resolveToolRenderers(name, () => runner.getToolDefinition(name));
}

function renderCallSnapshot(
	owner: PiBranchProjectionSource,
	call: TrackedToolCall,
	toolCallId: string,
	width: number,
): RenderedTextSnapshot | undefined {
	try {
		const definition = resolveToolRenderers(owner, call.name);
		if (!definition?.renderCall) return undefined;
		return {
			columns: width,
			collapsedLines: renderCallVariant(definition.renderCall, call, toolCallId, false, {}, width),
			expandedLines: renderCallVariant(definition.renderCall, call, toolCallId, true, {}, width),
		};
	} catch (error) {
		return { error: toCommandError(error).message };
	}
}

function renderResultSnapshot(
	owner: PiBranchProjectionSource,
	call: TrackedToolCall,
	toolCallId: string,
	result: unknown,
	isError: boolean,
	width: number,
	isPartial = false,
): RenderedTextSnapshot | undefined {
	try {
		const definition = resolveToolRenderers(owner, call.name);
		if (!definition?.renderResult) return undefined;
		return {
			columns: width,
			collapsedLines: renderResultVariant(
				definition,
				call,
				toolCallId,
				result as PiToolResult,
				false,
				isError,
				width,
				isPartial,
			),
			expandedLines: renderResultVariant(
				definition,
				call,
				toolCallId,
				result as PiToolResult,
				true,
				isError,
				width,
				isPartial,
			),
		};
	} catch (error) {
		return { error: toCommandError(error).message };
	}
}

/** One projection instance preserves call arguments until the matching result appears. */
export function createPiToolRendererProjection(
	owner: PiBranchProjectionSource,
	getWidth: () => number = () => EXTENSION_UI_RENDER_WIDTH,
) {
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
				if (!owner.extensions) return value;
				const outputPad = owner.extensions.settingsManager.getOutputPad();
				let changed = false;
				const content = source.content.map((candidate) => {
					const part = record(candidate);
					if (part?.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") {
						return candidate;
					}
					const call = {
						name: part.name,
						args: record(part.arguments) ?? {},
						cwd: owner.sessionManager.getCwd(),
						outputPad,
					};
					rememberCall(part.id, call);
					const rendered = renderCallSnapshot(owner, call, part.id, getWidth());
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
				if (!call || call.name !== source.toolName) return result;
				const rendered = renderResultSnapshot(owner, call, source.toolCallId, source, source.isError, getWidth());
				return rendered ? { ...result, rendered } : result;
			}
			return value;
		},
		projectPartial(toolCallId: string, result: unknown): RenderedTextSnapshot | undefined {
			const call = calls.get(toolCallId);
			if (!call) return undefined;
			return renderResultSnapshot(owner, call, toolCallId, result, false, getWidth(), true);
		},
		clear(): void {
			calls.clear();
		},
	};
}
