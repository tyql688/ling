import {
	dataHealthActionsAtom,
	dataHealthAtom,
	dataHealthErrorAtom,
	dataHealthOpenAtom,
	dataIssuesAtom,
	type DataRecoveryAction,
} from "@renderer/lib/data-health/state";
import { formatRequestError } from "@renderer/lib/errors";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

export function DataHealthLink() {
	const setOpen = useSetAtom(dataHealthOpenAtom),
		{ t } = useTranslation();
	return (
		<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
			{t("data.manage")}
		</Button>
	);
}
export function DataHealth() {
	const [open, setOpen] = useAtom(dataHealthOpenAtom);
	const health = useAtomValue(dataHealthAtom),
		transportError = useAtomValue(dataHealthErrorAtom),
		issues = useAtomValue(dataIssuesAtom),
		actions = useAtomValue(dataHealthActionsAtom);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null),
		[recovery, setRecovery] = useState<DataRecoveryAction | null>(null);
	const { t } = useTranslation();
	const unhealthy =
		transportError !== null ||
		health?.status === "unavailable" ||
		health?.status === "degraded" ||
		Object.keys(issues).length > 0;
	useEffect(() => {
		if (open && actions) void actions.refresh();
	}, [open, actions]);
	async function run(operation: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await operation();
		} catch (error) {
			setError(formatRequestError(error, t));
		} finally {
			setBusy(false);
		}
	}
	async function retry() {
		const results = await Promise.allSettled(
			[
				...(actions ? [actions.retry] : []),
				...Object.values(issues).flatMap((issue) => (issue.retry ? [issue.retry] : [])),
			].map((operation) => Promise.resolve().then(operation)),
		);
		const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		try {
			await actions?.refresh();
		} catch (cause) {
			failures.push(cause);
		}
		if (failures.length) throw new AggregateError(failures, "Some data could not be restored");
	}
	const details = [
		transportError,
		health?.message,
		health?.path,
		...Object.values(issues).map((issue) => `${issue.label}: ${issue.message}`),
		...(health?.issues.map((issue) => `${issue.source}: ${issue.message}`) ?? []),
	]
		.filter(Boolean)
		.join("\n");
	return (
		<>
			{unhealthy && !open && (
				<Button
					variant="outline"
					size="sm"
					className="fixed bottom-3 right-3 z-40 gap-2 bg-surface-raised shadow-sm"
					onClick={() => setOpen(true)}
				>
					<AlertTriangle className="size-4" aria-hidden="true" />
					{t("data.attention")}
				</Button>
			)}
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="flex max-h-[80dvh] flex-col">
					<DialogHeader>
						<DialogTitle>{t("data.title")}</DialogTitle>
						<DialogDescription>{t("data.description")}</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 overflow-y-auto divide-y divide-border-subtle">
						<div className="space-y-3 py-4">
							<p className="flex items-center gap-2 text-sm">
								{unhealthy ? (
									<AlertTriangle className="size-4" aria-hidden="true" />
								) : (
									<Check className="size-4" aria-hidden="true" />
								)}
								{t(health === null ? "data.loading" : unhealthy ? "data.degraded" : "data.ready")}
							</p>
							{unhealthy && <p className="text-sm text-text-muted">{t("data.retryHint")}</p>}
							<Button size="sm" variant="outline" disabled={busy || !actions} onClick={() => void run(retry)}>
								{t(busy ? "data.retrying" : "session.retry")}
							</Button>
						</div>
						{Object.entries(issues).map(([key, issue]) => (
							<div key={key} className="space-y-2 py-4">
								<h3 className="text-sm font-medium">{issue.label}</h3>
								<p className="whitespace-pre-wrap break-words text-xs text-text-muted">{issue.message}</p>
								{issue.action && (
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() => {
											void run(async () => {
												await issue.action!.run();
												setOpen(false);
											});
										}}
									>
										{issue.action.label}
									</Button>
								)}
								{issue.recovery && (
									<Button size="sm" variant="outline" disabled={busy} onClick={() => setRecovery(issue.recovery!)}>
										{issue.recovery.label}
									</Button>
								)}
							</div>
						))}
						{health?.issues
							.filter((issue) => !Object.hasOwn(issues, issue.key))
							.map((issue) => (
								<details key={issue.key} className="py-3 text-xs">
									<summary className="cursor-pointer break-all text-text-muted">{issue.source}</summary>
									<p className="whitespace-pre-wrap break-words py-2">{issue.message}</p>
								</details>
							))}
						{health && health.omittedIssues > 0 && (
							<p className="py-3 text-xs">{t("data.moreIssues", { count: health.omittedIssues })}</p>
						)}
						{details && (
							<details className="py-3 text-xs">
								<summary className="cursor-pointer text-text-muted">{t("data.details")}</summary>
								<pre className="whitespace-pre-wrap break-all py-3 select-text">{details}</pre>
								<Button
									size="sm"
									variant="outline"
									onClick={() => void run(() => navigator.clipboard.writeText(details))}
								>
									{t("data.copyDetails")}
								</Button>
							</details>
						)}
					</div>
					{error && (
						<p role="alert" className="text-xs text-danger">
							{error}
						</p>
					)}
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={recovery !== null}
				title={recovery?.description ?? ""}
				confirmLabel={recovery?.label ?? ""}
				cancelLabel={t("session.cancel")}
				destructive
				onConfirm={() => {
					if (recovery) {
						const action = recovery;
						setRecovery(null);
						void run(action.run);
					}
				}}
				onCancel={() => setRecovery(null)}
			/>
		</>
	);
}
