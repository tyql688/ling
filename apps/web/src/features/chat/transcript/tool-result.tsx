import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ToolResultSessionMessage } from "@ling/contracts/session-messages";
import { sessionKey } from "@ling/contracts/session-ref";
import { ImagePreviewDialog, type PreviewImage } from "@renderer/components/image-preview-dialog";
import { partsText } from "@renderer/features/chat/transcript/message-text";
import { DiffView } from "@renderer/features/review/diff-view";
import { sessionTranscriptStateFamily } from "@renderer/features/sessions/state/session";
import { formatRequestError } from "@renderer/lib/errors";
import { cn } from "@renderer/lib/utils";
import { Ansi } from "@renderer/components/ansi";
import { useAtomValue, useStore } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { TodoToolResult } from "@renderer/features/pi-adapters/todo/todo-tool-result";
import { useTranslation } from "react-i18next";
import { projectExtensionTerminalText } from "../extension-ui/extension-terminal-text";
import { RenderedTerminalLines } from "./assistant-render";
import { selectCustomMessageRenderedLines } from "./custom-message-lines";
import { useMessageImages } from "./message-images";
import { useSessionImageRef } from "./session-image-source";
import { toolCategoryForName } from "./transcript-activity-model";

type ToolResultMsg = ToolResultSessionMessage;
interface ToolResultProps {
	message: ToolResultMsg;
	showName?: boolean;
	command?: string | undefined;
	variant?: "card" | "inline";
	call?: ReactNode;
}
interface DetailAttempt {
	binding: string;
	promise: Promise<ToolResultMsg>;
}
// A cached detail lives only as long as its summary, and is replaced after a runtime/branch change.
const details = new WeakMap<ToolResultMsg, DetailAttempt>();
type DetailState = { source: ToolResultMsg; binding: string } & (
	{ status: "ready"; message: ToolResultMsg } | { status: "error"; error: string }
);

export function ToolResultBlock(props: ToolResultProps) {
	if (props.message.contentState !== "deferred") return <LoadedToolResult {...props} />;
	return <DeferredToolResult {...props} />;
}

function DeferredToolResult(props: ToolResultProps) {
	const hostSessionApi = useDomainApi("session");

	const { message } = props;
	const ref = useSessionImageRef();
	const store = useStore();
	const key = ref === null ? "" : sessionKey(ref);
	const transcript = useAtomValue(sessionTranscriptStateFamily(key));
	const binding = `${key}:${transcript.epoch}:${transcript.runtimeId}:${transcript.generation}`;
	const [state, setState] = useState<DetailState | null>(null);
	const [attempt, setAttempt] = useState(0);
	const { t } = useTranslation();
	useEffect(() => {
		// Retained rows can remain visible while resume or resync obtains a fresh binding.
		if (ref !== null && transcript.runtimeId === null) return;
		let cancelled = false;
		const load = async (): Promise<ToolResultMsg> => {
			const current = store.get(sessionTranscriptStateFamily(key));
			if (ref === null || message.entryId === null || current.runtimeId === null) {
				throw new Error("The tool result has no active session binding.");
			}
			const result = await hostSessionApi.readToolResult({
				ref,
				entryId: message.entryId,
				runtimeId: current.runtimeId,
				generation: current.generation,
				expectedTranscriptRevision: current.currentRevision,
			});
			if (
				result.entryId !== message.entryId ||
				result.toolCallId !== message.toolCallId ||
				result.contentState === "deferred"
			) {
				throw new Error("The tool detail response does not match the requested result.");
			}
			return result;
		};
		let cached = details.get(message);
		if (cached?.binding !== binding) {
			cached = { binding, promise: load() };
			details.set(message, cached);
		}
		const pending = cached;
		void pending.promise.then(
			(result) => {
				if (!cancelled) setState({ source: message, binding, status: "ready", message: result });
			},
			(cause: unknown) => {
				if (details.get(message) === pending) details.delete(message);
				if (!cancelled) setState({ source: message, binding, status: "error", error: formatRequestError(cause) });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [hostSessionApi, attempt, binding, key, message, ref, store, transcript.runtimeId]);
	const current = state?.source === message && state.binding === binding ? state : null;
	if (current?.status === "ready") return <LoadedToolResult {...props} message={current.message} />;
	return (
		<>
			{props.call}
			{current?.status === "error" ? (
				<div role="alert" className="flex items-center gap-2 text-xs text-danger">
					<span>{current.error}</span>
					<button
						type="button"
						className="shrink-0 underline"
						onClick={() => {
							setState(null);
							setAttempt((value) => value + 1);
						}}
					>
						{t("session.retry")}
					</button>
				</div>
			) : (
				<div role="status" className="py-2 text-xs text-text-muted">
					{t("session.loadingToolDetails")}
				</div>
			)}
		</>
	);
}

function LoadedToolResult(props: ToolResultProps) {
	const { t } = useTranslation();
	const rendered = props.message.rendered?.error
		? null
		: selectCustomMessageRenderedLines(props.message.rendered, true);
	const { message } = props;
	return (
		<TodoToolResult message={message}>
			{props.call}
			{rendered ? (
				<RenderedTerminalLines lines={rendered.lines} inline={props.variant === "inline"} />
			) : (
				<ToolResultContent {...props} />
			)}
			{message.nestedCalls && (
				<details className="mt-3 text-xs">
					<summary className="cursor-pointer text-text-muted">
						{t("session.nestedCalls", { count: message.nestedCalls.calls.length })}
					</summary>
					<div className="mt-2 flex flex-col gap-2">
						{message.nestedCalls.calls.map((call) => (
							<details key={call.id} className="rounded-control border border-border-subtle px-3 py-2">
								<summary className="cursor-pointer break-all">
									<span className="font-mono">{call.name}</span>
									<span className={cn("ml-2", call.status === "error" ? "text-danger" : "text-text-muted")}>
										{t(`session.nestedStatus_${call.status}`)}
									</span>
									{call.durationMs !== undefined && (
										<span className="ml-2 tabular-nums text-text-muted">{call.durationMs} ms</span>
									)}
								</summary>
								{call.arguments !== undefined && (
									<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
										{JSON.stringify(call.arguments, null, 2)}
									</pre>
								)}
								{call.argumentsBytes !== undefined && (
									<p className="mt-2 text-text-muted">
										{t("session.nestedArgumentsOmitted", { count: call.argumentsBytes })}
									</p>
								)}
								{call.error && <p className="mt-2 whitespace-pre-wrap text-danger">{call.error}</p>}
							</details>
						))}
						{!message.nestedCalls.complete && <p className="text-text-muted">{t("session.nestedIncomplete")}</p>}
					</div>
				</details>
			)}
		</TodoToolResult>
	);
}

function extractDiff(details: unknown): string | undefined {
	if (details && typeof details === "object" && "diff" in details) {
		const diff = details.diff;
		if (typeof diff === "string") return diff;
	}
	return undefined;
}

/** Display cap for one tool result. Pi's own truncation bounds what the model sees, but the raw
 * text still crosses IPC (up to 64 MiB per part) and ansi-to-react builds one element per escape
 * span, so an unbounded ANSI-heavy bash result can take the renderer to OOM (observed 14.5 GiB peak). */
const TOOL_OUTPUT_DISPLAY_MAX_CHARS = 200_000;

function clampToolOutput(text: string, t: (key: string, options: { count: number }) => string): string {
	if (text.length <= TOOL_OUTPUT_DISPLAY_MAX_CHARS) return text;
	const hidden = text.length - TOOL_OUTPUT_DISPLAY_MAX_CHARS;
	return `${text.slice(0, TOOL_OUTPUT_DISPLAY_MAX_CHARS)}\n… ${t("session.toolOutputTruncated", { count: hidden })}`;
}

function ToolResultContent({
	message,
	showName = true,
	command,
	variant = "card",
}: {
	message: ToolResultMsg;
	showName?: boolean;
	command?: string | undefined;
	variant?: "card" | "inline";
}) {
	const { t } = useTranslation();
	const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
	const diff = extractDiff(message.details);
	const text = clampToolOutput(partsText(message.content), t);
	const displayCommand = command === undefined ? undefined : clampToolOutput(command, t);
	// Pi's TUI draws these inline through the terminal image protocols; a `read` on a PNG,
	// an MCP screenshot, or an extension tool all arrive here as image content parts.
	const images = useMessageImages(message.content);
	const isTerminal = toolCategoryForName(message.toolName) === "run";
	const isSearch = message.toolName === "grep" || message.toolName === "find";
	const outputClassName = cn(
		"max-h-72 min-w-0 overflow-auto overscroll-contain font-mono text-xs leading-relaxed [tab-size:4]",
		// Search lines keep their path/line alignment while a pane resizes; scroll exposes long matches.
		isSearch ? "whitespace-pre" : "whitespace-pre-wrap",
		command ? "mt-3" : "mt-1",
		message.isError ? "text-text-primary" : "text-text-muted",
	);

	return (
		<div
			className={cn(
				"w-full min-w-0",
				variant === "card" && "rounded-panel border px-3.5 py-3 shadow-xs",
				variant === "card" && (message.isError ? "border-danger/40 bg-danger/10" : "border-border-subtle bg-surface"),
				variant === "inline" && isSearch && "rounded-control border border-border-subtle bg-surface px-3 py-2.5",
			)}
		>
			{showName && (
				<div className={cn("font-mono text-xs", message.isError ? "text-danger" : "text-text-muted")}>
					{message.toolName}
				</div>
			)}
			{displayCommand && (
				<pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-text-primary">
					{displayCommand}
				</pre>
			)}
			{diff ? (
				<div className="mt-3">
					<DiffView diff={diff} />
				</div>
			) : isTerminal ? (
				<div>
					<Ansi className={outputClassName} useClasses>
						{projectExtensionTerminalText(text)}
					</Ansi>
				</div>
			) : (
				<pre className={outputClassName}>{text}</pre>
			)}
			{images.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1.5">
					<ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
					{images.map((image, imageIndex) => {
						const src = image.src;
						return (
							<button
								// eslint-disable-next-line react/no-array-index-key -- images never reorder within a tool result
								key={imageIndex}
								type="button"
								className="size-24 overflow-hidden rounded-control border border-border-subtle"
								onClick={() => setPreviewImage({ src })}
								aria-label={t("session.imagePreview")}
							>
								<img src={src} alt="" className="size-full object-cover" />
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
