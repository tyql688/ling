import type { ToolExecutionProgress } from "@ling/contracts/session-tool-progress";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useStreamingText } from "@renderer/hooks/use-streaming-text";
import Ansi from "ansi-to-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RenderedTerminalLines } from "./assistant-render";
import { selectCustomMessageRenderedLines } from "./custom-message-lines";
import { projectExtensionTerminalText } from "../extension-ui/extension-terminal-text";

/** A bounded, live preview; the final tool result replaces this surface when execution ends. */
export function ToolProgressBlock({ progress }: { progress: ToolExecutionProgress }) {
	const { t } = useTranslation();
	const outputRef = useRef<HTMLDivElement>(null);
	const followsTail = useRef(true);
	// Text output has a stable append cursor. Details-only updates retain Pi's custom
	// progress bars and counters; completed results still use the full tool renderer.
	const rendered =
		progress.text.length > 0 || progress.rendered?.error
			? null
			: selectCustomMessageRenderedLines(progress.rendered, true);
	const output = useStreamingText(progress.text, true, rendered === null);
	useEffect(() => {
		const output = outputRef.current;
		if (output && followsTail.current) output.scrollTop = output.scrollHeight;
	}, [output.text, rendered]);
	return (
		<div data-tool-progress={progress.toolCallId}>
			{progress.rendered?.error && <FeedbackNotice tone="danger">{progress.rendered.error}</FeedbackNotice>}
			<div
				ref={outputRef}
				className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-text-muted"
				onScroll={(event) => {
					const element = event.currentTarget;
					// Two pixels tolerate fractional scroll geometry at the end of a line.
					followsTail.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
				}}
			>
				{rendered ? (
					<RenderedTerminalLines lines={rendered.lines} inline />
				) : (
					<Ansi useClasses>{projectExtensionTerminalText(output.text)}</Ansi>
				)}
			</div>
			{progress.truncated && <p className="mt-1 text-xs text-text-muted">{t("session.liveToolOutputTruncated")}</p>}
		</div>
	);
}
