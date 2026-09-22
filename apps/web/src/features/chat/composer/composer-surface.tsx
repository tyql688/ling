import { ComposerCard } from "@renderer/features/chat/composer/composer-shell";
import { ComposerInteractions } from "@renderer/features/interactions/interactions-provider";
import type { SessionRef } from "@ling/contracts/session-ref";
import { composerEditorModeAtom } from "@renderer/lib/preferences/composer";
import { useAtomValue } from "jotai";
import type { ReactNode, Ref } from "react";

import { lazy, Suspense } from "react";
import type { ComposerEditorHandle, ComposerEditorProps } from "./composer-editor";

const ComposerEditor = lazy(() => import("./composer-editor").then((module) => ({ default: module.ComposerEditor })));

/** Every composing surface shares the same deferred editor load and loading geometry. */
export function ComposerInput(props: ComposerEditorProps) {
	const mode = useAtomValue(composerEditorModeAtom);
	return (
		<Suspense fallback={<div className="min-h-12" aria-busy="true" />}>
			<ComposerEditor key={mode} {...props} markdown={mode === "markdown"} />
		</Suspense>
	);
}

export function ComposerSurface({
	variant,
	dropActive,
	dropHandlers,
	popover,
	alerts,
	banner,
	attachments,
	editorKey,
	editorRef,
	editor,
	editorClassName,
	footer,
	trailing,
	sessionRef,
}: {
	variant: "session" | "home";
	/** Conversation whose pending questions and approvals show above the editor. */
	sessionRef?: SessionRef;
	dropActive: boolean;
	dropHandlers?: Record<string, unknown> | undefined;
	/** Completion/command popover. */
	popover?: ReactNode;
	/** Inline alerts for issues/length limits; ordering is up to the variant. */
	alerts?: ReactNode;
	/** Status banner above the editor (e.g. the queuedEdit notice). */
	banner?: ReactNode;
	attachments?: ReactNode;
	editorKey: string;
	editorRef?: Ref<ComposerEditorHandle> | undefined;
	editor: Omit<ComposerEditorProps, "ref" | "className">;
	editorClassName?: string | undefined;
	/** Primary action row below the editor (session = toolbar; home = model/send pill row). */
	footer?: ReactNode;
	/** Trailing content inside the card but outside the main body (home error block and project picker). */
	trailing?: ReactNode;
}) {
	return (
		<>
			{sessionRef && <ComposerInteractions sessionRef={sessionRef} />}
			<ComposerCard variant={variant} dropActive={dropActive} dropHandlers={dropHandlers}>
				{popover}
				<div className="flex flex-col gap-3">
					{alerts}
					{banner}
					{attachments}
					<ComposerInput key={editorKey} ref={editorRef} {...editor} className={editorClassName} />
					{footer}
				</div>
				{trailing}
			</ComposerCard>
		</>
	);
}
