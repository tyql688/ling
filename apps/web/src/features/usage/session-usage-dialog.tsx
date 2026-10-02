import type { SessionMessage } from "@ling/contracts/session-messages";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";

import { ChartColumn } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./session-usage.css";
import type { ContextUsage } from "./workspace-session-usage";

const SessionUsageDetails = lazy(() =>
	import("./session-usage-details").then(({ SessionUsageDetails }) => ({ default: SessionUsageDetails })),
);

interface SessionUsageDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	messages: readonly SessionMessage[];
	contextUsage: ContextUsage | null;
	ready: boolean;
}

export function SessionUsageDialog({ open, onOpenChange, messages, contextUsage, ready }: SessionUsageDialogProps) {
	const { t } = useTranslation();
	// Stats computation and chart mounting are deferred until the opening animation starts, avoiding main-thread contention with the zoom frame.
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (!open) {
			// Unmount content only after the exit animation finishes, otherwise the panel flips back to the loading state before it shrinks.
			const timer = setTimeout(() => setSettled(false), 200);
			return () => clearTimeout(timer);
		}
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setSettled(true));
		});
		// A backgrounded window may not receive animation frames.
		const fallback = window.setTimeout(() => setSettled(true), 120);
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
			window.clearTimeout(fallback);
		};
	}, [open]);
	const loading = (
		<div className="grid min-h-0 flex-1 place-items-center">
			<LoadingTransition label={t("session.usageLoading")} />
		</div>
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				id="session-usage-dialog"
				size="medium"
				overlayClassName="session-usage-overlay"
				className="session-usage-dialog flex h-[min(44rem,calc(100dvh-2rem))] max-w-[40rem] flex-col overflow-hidden p-0"
			>
				<header className="flex h-11 shrink-0 items-center border-b border-border-subtle px-4 pr-12">
					<DialogTitle className="flex items-center gap-2">
						<ChartColumn className="size-4 text-accent" aria-hidden="true" />
						{t("session.usageTitle")}
					</DialogTitle>
					<DialogDescription className="sr-only">{t("session.usageDescription")}</DialogDescription>
				</header>
				<DialogCloseButton className="top-2 right-2" aria-label={t("session.usageClose")} />
				{ready && settled ? (
					<Suspense fallback={loading}>
						<SessionUsageDetails messages={messages} contextUsage={contextUsage} />
					</Suspense>
				) : (
					loading
				)}
			</DialogContent>
		</Dialog>
	);
}
