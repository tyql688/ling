import type { ExtensionUiStateSnapshot } from "@ling/contracts/session-extension-ui";
import { WORKSPACE_PANEL_HEADER_CLASS } from "@renderer/components/shell-chrome";
import { cn } from "@renderer/lib/utils";
import Ansi from "ansi-to-react";
import { Blocks, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ExtensionWidget, hasVisibleTerminalText, visibleWidgets } from "./extension-dock-count";
import { ExtensionNotificationHistory } from "./extension-notification-history";
import { projectExtensionTerminalText } from "./extension-terminal-text";
import { ExtensionLinesBlock } from "./extension-ui-surface";
import { EXTENSION_DOCK_LINE_CLASS } from "./extension-dock-layout";

function SurfaceHeading({ title, count }: { title: string; count: number }) {
	return (
		<div className="flex items-center justify-between gap-2 px-0.5">
			<h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</h3>
			<span className="font-mono text-xs tabular-nums text-text-primary/65">{count}</span>
		</div>
	);
}

function WidgetSurface({ widget, placement }: { widget: ExtensionWidget; placement: string }) {
	return (
		<div
			data-extension-widget-key={widget.key}
			className="overflow-hidden rounded-control border border-border-subtle bg-surface-raised/60"
		>
			<div className="flex min-w-0 items-center justify-between gap-2 border-border-subtle border-b px-2.5 py-1.5">
				<span className="truncate font-mono text-xs text-text-muted">{widget.key}</span>
				<span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 font-mono text-xs text-text-primary/65">
					{placement}
				</span>
			</div>
			<div className="max-w-full overflow-x-auto overscroll-x-contain p-2.5">
				<ExtensionLinesBlock
					lines={widget.lines}
					className={cn("w-max min-w-full text-text-muted", EXTENSION_DOCK_LINE_CLASS)}
				/>
			</div>
		</div>
	);
}

function DockBody({
	state,
	onOpenLinkError,
}: {
	state: ExtensionUiStateSnapshot;
	onOpenLinkError: (error: unknown) => void;
}) {
	const { t } = useTranslation();
	const statuses =
		state.footerLines === null ? state.statuses.filter((status) => hasVisibleTerminalText(status.text)) : [];
	const widgets = visibleWidgets(state.widgets);
	const above = widgets.filter((widget) => widget.placement === "aboveComposer");
	const below = widgets.filter((widget) => widget.placement === "belowComposer");
	const footerLines = state.footerLines?.filter(hasVisibleTerminalText) ?? [];
	const empty =
		state.notifications.length === 0 && statuses.length === 0 && widgets.length === 0 && footerLines.length === 0;

	if (empty) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
				<div className="flex size-10 items-center justify-center rounded-panel border border-border-subtle bg-surface-raised">
					<Blocks className="size-4 text-text-muted" aria-hidden="true" />
				</div>
				<p className="text-sm font-medium text-text-primary">{t("extensionUi.dockEmpty")}</p>
				<p className="max-w-[16rem] text-xs leading-relaxed text-text-muted">{t("extensionUi.dockEmptyHint")}</p>
			</div>
		);
	}

	return (
		<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
			{state.notifications.length > 0 && (
				<section className="space-y-1.5">
					<SurfaceHeading title={t("extensionUi.activity")} count={state.notifications.length} />
					<ExtensionNotificationHistory notifications={state.notifications} onOpenLinkError={onOpenLinkError} />
				</section>
			)}
			{statuses.length > 0 && (
				<section className="space-y-1.5">
					<SurfaceHeading title={t("extensionUi.statuses")} count={statuses.length} />
					<div className="divide-y divide-border-subtle overflow-hidden rounded-control border border-border-subtle bg-surface-raised/60">
						{statuses.map((status) => (
							<div
								key={status.key}
								className="grid min-w-0 grid-cols-[minmax(4.5rem,auto)_minmax(0,1fr)] items-start gap-x-3 px-2.5 py-2"
							>
								<span className="flex min-w-0 items-center gap-2 font-mono text-xs text-text-primary/65">
									<span className="size-1.5 shrink-0 rounded-full bg-text-muted/50" aria-hidden="true" />
									<span className="truncate">{status.key}</span>
								</span>
								<span className="min-w-0 whitespace-pre-wrap text-right font-mono text-xs text-text-muted [overflow-wrap:anywhere]">
									<Ansi useClasses>{projectExtensionTerminalText(status.text)}</Ansi>
								</span>
							</div>
						))}
					</div>
				</section>
			)}
			{above.length > 0 && (
				<section className="space-y-1.5">
					<SurfaceHeading title={t("extensionUi.widgetsAboveEditor")} count={above.length} />
					<div className="space-y-2">
						{above.map((widget) => (
							<WidgetSurface key={widget.key} widget={widget} placement="aboveEditor" />
						))}
					</div>
				</section>
			)}
			{below.length > 0 && (
				<section className="space-y-1.5">
					<SurfaceHeading title={t("extensionUi.widgetsBelowEditor")} count={below.length} />
					<div className="space-y-2">
						{below.map((widget) => (
							<WidgetSurface key={widget.key} widget={widget} placement="belowEditor" />
						))}
					</div>
				</section>
			)}
			{footerLines.length > 0 && (
				<section className="space-y-1.5">
					<SurfaceHeading title={t("extensionUi.footerOutput")} count={1} />
					<div className="overflow-hidden rounded-control border border-border-subtle bg-surface-raised/60">
						<div className="border-border-subtle border-b px-2.5 py-1.5 text-xs text-text-muted">
							{t("extensionUi.footerReplacesStatus")}
						</div>
						<div className="max-w-full overflow-x-auto overscroll-x-contain p-2.5">
							<ExtensionLinesBlock
								lines={footerLines}
								className={cn("w-max min-w-full text-text-muted", EXTENSION_DOCK_LINE_CLASS)}
							/>
						</div>
					</div>
				</section>
			)}
		</div>
	);
}

/**
 * Right-side extension panel. Takes no layout space when `open=false`; content is projected
 * from Pi extension notifications and persisted state.
 */
export function ExtensionDock({
	state,
	open,
	onClose,
	onOpenLinkError,
	docked = false,
}: {
	state: ExtensionUiStateSnapshot;
	open: boolean;
	onClose: () => void;
	onOpenLinkError: (error: unknown) => void;
	/** Inline in the workspace side panel: no own width, resize handle, or border. */
	docked?: boolean | undefined;
}) {
	const { t } = useTranslation();
	if (!open) return null;

	return (
		<aside
			data-extension-dock=""
			aria-label={t("extensionUi.dockTitle")}
			className="view-fade-in relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
		>
			{!docked && (
				<header className={WORKSPACE_PANEL_HEADER_CLASS}>
					<div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-surface-hover">
						<Blocks className="size-3.5 text-text-muted" aria-hidden="true" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs font-medium text-text-primary">{t("extensionUi.dockTitle")}</div>
						<div className="truncate text-xs text-text-muted">{t("extensionUi.dockDescription")}</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("extensionUi.closeDock")}
						className="flex size-7 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
					>
						<X className="size-3.5" aria-hidden="true" />
					</button>
				</header>
			)}
			<DockBody state={state} onOpenLinkError={onOpenLinkError} />
		</aside>
	);
}
