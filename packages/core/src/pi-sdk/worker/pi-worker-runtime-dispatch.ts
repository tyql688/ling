import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import { dispatchPiMethod, type PiMethodHandlers } from "../../pi-protocol/method";
import type { PiWorkerRuntimeMethod } from "../../pi-protocol/methods";
import { piRuntimeMethods } from "../../pi-protocol/runtime-methods";

interface PiWorkerRuntimeDispatchOptions {
	/** Snapshot capture and replacement remain owned by the runtime lifecycle service. */
	method: PiWorkerRuntimeMethod;
	args: Record<string, unknown>;
	runtime: SessionRuntimePort;
	signal: AbortSignal;
	dispose(rollbackSessionFile: boolean): Promise<void>;
}
type RuntimeCallMethod = Exclude<keyof typeof piRuntimeMethods, "runtime.getSnapshot" | "runtime.getStateSnapshot">;
const handlers: PiMethodHandlers<Pick<typeof piRuntimeMethods, RuntimeCallMethod>, PiWorkerRuntimeDispatchOptions> = {
	"runtime.deliverReply": async (args, { runtime }) => {
		await runtime.deliverReply(args.requestId, args.text);
		return null;
	},
	"runtime.readLatestToolResult": (args, { runtime }) => runtime.readLatestToolResult(args.toolName),
	"runtime.readCustomEntry": (args, { runtime }) => runtime.readCustomEntry(args.customType),
	"runtime.startCompanionRun": (args, { runtime }) =>
		runtime.startCompanionRun(args.runId, args.text, args.configuration),
	"runtime.waitCompanionRun": (args, { runtime }) => runtime.waitCompanionRun(args.runId),
	"runtime.cancelCompanionRun": (args, { runtime }) => runtime.cancelCompanionRun(args.runId),
	"runtime.getBranchLeafEntryId": async (_args, options) => {
		const { runtime } = options;
		return await runtime.getBranchLeafEntryId();
	},
	"runtime.getFirstUserMessageText": async (_args, options) => {
		const { runtime } = options;
		return await runtime.getFirstUserMessageText();
	},
	"runtime.setSessionName": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		await runtime.setSessionName(parsed.title);
		return null;
	},
	"runtime.generateTitle": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return (await runtime.generateTitle(parsed.userMessage)) ?? null;
	},
	"runtime.refreshFromDisk": async (_args, options) => {
		const { runtime } = options;
		await runtime.refreshFromDisk();
		return null;
	},
	"runtime.reloadResources": async (_args, options) => {
		const { runtime } = options;
		await runtime.reloadResources();
		return null;
	},
	"runtime.readToolResult": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.readToolResult(parsed.entryId);
	},
	"runtime.readImagePart": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.readImagePart(parsed.entryId, parsed.index);
	},
	"runtime.sendPrompt": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		const images = parsed.images;
		await runtime.sendPrompt(parsed.text, images);
		return null;
	},
	"runtime.steer": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		const images = parsed.images;
		const fileReferences = parsed.fileReferences;
		await runtime.steer(parsed.text, images, fileReferences);
		return null;
	},
	"runtime.followUp": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		const images = parsed.images;
		const fileReferences = parsed.fileReferences;
		await runtime.followUp(parsed.text, images, fileReferences);
		return null;
	},
	"runtime.editQueuedMessage": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		const images = parsed.images;
		const fileReferences = parsed.fileReferences;
		await runtime.editQueuedMessage(
			parsed.kind,
			parsed.index,
			parsed.expectedText,
			parsed.text,
			images,
			fileReferences,
		);
		return null;
	},
	"runtime.promoteQueuedMessage": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		await runtime.promoteQueuedMessage(parsed.index, parsed.expectedText);
		return null;
	},
	"runtime.abort": async (_args, options) => {
		const { runtime } = options;
		return await runtime.abort();
	},
	"runtime.compact": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		await runtime.compact(parsed.customInstructions);
		return null;
	},
	"runtime.retryTurn": async (args, { runtime }) => {
		await runtime.retryTurn(args.entryId);
		return null;
	},
	"runtime.rewindToEntry": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		await runtime.rewindToEntry(parsed.entryId);
		return null;
	},
	"runtime.getCommandArgumentCompletions": async (args, options) => {
		const { runtime, signal } = options;
		const parsed = args;
		return await runtime.getCommandArgumentCompletions(parsed.commandName, parsed.argumentPrefix, signal);
	},
	"runtime.sendExtensionUiInput": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.sendExtensionUiInput(parsed.data);
	},
	"runtime.dispatchExtensionTerminalInput": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.dispatchExtensionTerminalInput(parsed.data);
	},
	"runtime.updateExtensionUiViewport": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		await runtime.updateExtensionUiViewport(parsed.columns, parsed.rows, parsed.markdownColumns, parsed.dockColumns);
		return null;
	},
	"runtime.setExtensionUiEditorText": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		await runtime.setExtensionUiEditorText(parsed.text);
		return null;
	},
	"runtime.getExtensionAutocompleteSuggestions": async (args, options) => {
		const { runtime, signal } = options;
		const parsed = args;
		return await runtime.getExtensionAutocompleteSuggestions(parsed.text, parsed.cursorOffset, parsed.force, signal);
	},
	"runtime.applyExtensionAutocomplete": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.applyExtensionAutocomplete(parsed.text, parsed.cursorOffset, parsed.item, parsed.prefix);
	},
	"runtime.getModelState": async (_args, options) => {
		const { runtime } = options;
		return await runtime.getModelState();
	},
	"runtime.setModel": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.setModel(parsed.provider, parsed.modelId);
	},
	"runtime.setThinkingLevel": async (args, options) => {
		const { runtime } = options;
		const parsed = args;
		return await runtime.setThinkingLevel(parsed.level);
	},
	"runtime.dispose": async (args, options) => {
		const parsed = args;
		await options.dispose(parsed.rollbackSessionFile === true);
		return null;
	},
};
export async function dispatchPiWorkerRuntimeCall(options: PiWorkerRuntimeDispatchOptions): Promise<unknown> {
	if (!Object.hasOwn(handlers, options.method)) throw new Error(`Invalid runtime call dispatch: ${options.method}`);
	return dispatchPiMethod(piRuntimeMethods, handlers, options.method as RuntimeCallMethod, options.args, options);
}
