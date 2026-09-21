import { ErrorBoundary } from "@renderer/components/error-boundary";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { cn } from "@renderer/lib/utils";
import { CircleAlert, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

/** Error details text: message + stack; copy and display share the same content. */
function errorDetails(error: Error): string {
	if (error.stack === undefined) return error.message;
	return error.stack.includes(error.message) ? error.stack : `${error.message}\n${error.stack}`;
}

/** Full-window fallback: root boundary only; the only recovery path is reloading the window. */
export function AppErrorFallback({ error }: { error: Error }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-surface-under px-8">
			<CircleAlert className="size-8 text-danger" aria-hidden="true" />
			<div className="flex max-w-lg flex-col items-center gap-1 text-center">
				<h1 className="text-base font-medium text-text-primary">{t("errorBoundary.appTitle")}</h1>
				<p className="text-sm text-text-muted">{t("errorBoundary.appDescription")}</p>
			</div>
			<pre className="max-h-48 w-full max-w-lg overflow-auto whitespace-pre-wrap break-words rounded-control border border-border-subtle bg-surface p-3 font-mono text-xs leading-relaxed text-text-muted">
				{errorDetails(error)}
			</pre>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						void navigator.clipboard.writeText(errorDetails(error)).then(() => setCopied(true));
					}}
				>
					{copied ? t("errorBoundary.copied") : t("errorBoundary.copyDetails")}
				</Button>
				<Button size="sm" onClick={() => window.location.reload()}>
					{t("errorBoundary.reload")}
				</Button>
			</div>
		</div>
	);
}

/** Panel-level fallback: shared by the shell and panels (Settings/Workspace/review/terminal/preview). */
function PanelErrorFallback({
	error,
	onRetry,
	className,
}: {
	error: Error;
	onRetry: () => void;
	className?: string | undefined;
}) {
	const { t } = useTranslation();
	return (
		<div className={cn("flex min-h-0 flex-1 items-start justify-center overflow-auto p-4", className)}>
			<FeedbackNotice
				tone="danger"
				title={t("errorBoundary.panelTitle")}
				className="w-full max-w-lg"
				action={
					<Button variant="outline" size="sm" onClick={onRetry}>
						<RotateCcw className="size-3.5" aria-hidden="true" />
						{t("errorBoundary.retry")}
					</Button>
				}
			>
				<span className="break-words font-mono text-xs">{error.message}</span>
			</FeedbackNotice>
		</div>
	);
}

/** Panel boundary wrapper: wraps the subtree directly at shell/panel wiring, saving a fallback closure layer. */
export function PanelBoundary({
	resetKeys,
	fallbackClassName,
	children,
}: {
	resetKeys?: readonly unknown[] | undefined;
	fallbackClassName?: string | undefined;
	children: ReactNode;
}) {
	return (
		<ErrorBoundary
			resetKeys={resetKeys}
			fallback={(error, reset) => <PanelErrorFallback error={error} onRetry={reset} className={fallbackClassName} />}
		>
			{children}
		</ErrorBoundary>
	);
}

/** Inline fallback: placeholder for a single transcript message that failed to render, without affecting the rest of the timeline. */
export function InlineErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
	const { t } = useTranslation();
	return (
		<div
			role="alert"
			className="flex items-center gap-2 rounded-control border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
			title={error.message}
		>
			<CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate">{t("errorBoundary.inlineMessage")}</span>
			<button
				type="button"
				onClick={onRetry}
				className="shrink-0 rounded-sm px-1.5 py-0.5 underline-offset-2 hover:underline"
			>
				{t("errorBoundary.retry")}
			</button>
		</div>
	);
}
