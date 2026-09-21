import { useDomainApi } from "@renderer/lib/host-api-context";
import type { GitGraph, GitStatus } from "@ling/contracts/git";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { formatRequestError } from "@renderer/lib/errors";
import { noDragRegionClassName } from "@renderer/lib/platform";
import { GitBranch } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { GitHistoryPanel } from "./git-history-panel";

interface BranchPickerProps {
	cwd: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Surfaces git failures (dirty tree, missing branch, remote errors) to the parent toast. */
	onError: (message: string) => void;
	onChanged?: () => void;
	/** Extra status-bar segments that stay available when the project is not a Git repository. */
	children?: ReactNode;
}

type DialogKind = "createBranch" | null;

/**
 * Status-bar Git control: status stays compact in the footer; opening it uses the shared
 * workbench dialog for the commit DAG, refs, search, and branch switching.
 */
export function BranchPicker({ cwd, open, onOpenChange, onError, onChanged, children }: BranchPickerProps) {
	const hostGitApi = useDomainApi("git");

	const { t } = useTranslation();
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [graph, setGraph] = useState<GitGraph | null>(null);
	const [graphError, setGraphError] = useState<string | null>(null);
	const [graphLoading, setGraphLoading] = useState(false);
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [dialog, setDialog] = useState<DialogKind>(null);
	const [branchName, setBranchName] = useState("");
	const [query, setQuery] = useState("");
	const [switchTarget, setSwitchTarget] = useState<string | null>(null);
	const [switchMessage, setSwitchMessage] = useState("");
	const statusRequestRef = useRef(0);
	const graphRequestRef = useRef(0);
	const statusInFlightRef = useRef<Promise<void> | null>(null);
	const graphInFlightRef = useRef<Promise<void> | null>(null);
	const statusRefreshQueuedRef = useRef(false);
	const graphRefreshQueuedRef = useRef(false);
	const mountedRef = useRef(false);
	const refreshStatusRef = useRef<() => void>(() => undefined);
	const refreshGraphRef = useRef<() => void>(() => undefined);
	const [workbenchHost, setWorkbenchHost] = useState<HTMLElement | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		setWorkbenchHost(anchorRef.current?.closest<HTMLElement>("[data-workbench-slot-host]") ?? null);
	}, [status?.isRepository]);

	const refreshStatus = useCallback((): void => {
		if (statusInFlightRef.current) {
			statusRefreshQueuedRef.current = true;
			return;
		}
		const requestId = statusRequestRef.current + 1;
		statusRequestRef.current = requestId;
		const operation: Promise<void> = hostGitApi
			.getStatus(cwd)
			.then((next) => {
				if (statusRequestRef.current === requestId) setStatus(next);
			})
			.catch((error: unknown) => {
				if (statusRequestRef.current !== requestId) return;
				setStatus(null);
				onError(formatRequestError(error));
			})
			.finally(() => {
				if (statusInFlightRef.current !== operation) return;
				statusInFlightRef.current = null;
				if (!mountedRef.current || !statusRefreshQueuedRef.current) return;
				statusRefreshQueuedRef.current = false;
				refreshStatusRef.current();
			});
		statusInFlightRef.current = operation;
	}, [hostGitApi, cwd, onError]);
	refreshStatusRef.current = refreshStatus;

	useEffect(() => {
		if (!open) setQuery("");
	}, [open]);

	useEffect(() => {
		mountedRef.current = true;
		setStatus(null);
		setGraph(null);
		setGraphError(null);
		setGraphLoading(false);
		onOpenChange(false);
		setDialog(null);
		setBranchName("");
		setQuery("");
		setSwitchTarget(null);
		setSwitchMessage("");
		statusRequestRef.current += 1;
		graphRequestRef.current += 1;
		refreshStatus();
		const handleFocus = () => refreshStatus();
		window.addEventListener("focus", handleFocus);
		return () => {
			mountedRef.current = false;
			statusRefreshQueuedRef.current = false;
			graphRefreshQueuedRef.current = false;
			statusRequestRef.current += 1;
			graphRequestRef.current += 1;
			window.removeEventListener("focus", handleFocus);
		};
	}, [onOpenChange, refreshStatus]);

	const refreshGraph = useCallback((): void => {
		refreshStatus();
		if (graphInFlightRef.current) {
			graphRefreshQueuedRef.current = true;
			return;
		}
		const requestId = graphRequestRef.current + 1;
		graphRequestRef.current = requestId;
		setGraphLoading(true);
		const operation: Promise<void> = hostGitApi
			.getGraph(cwd)
			.then((nextGraph) => {
				if (graphRequestRef.current !== requestId) return;
				setGraph(nextGraph);
				setGraphError(null);
			})
			.catch((error: unknown) => {
				if (graphRequestRef.current !== requestId) return;
				setGraphError(formatRequestError(error));
			})
			.finally(() => {
				if (graphInFlightRef.current !== operation) return;
				graphInFlightRef.current = null;
				if (mountedRef.current && graphRefreshQueuedRef.current) {
					graphRefreshQueuedRef.current = false;
					refreshGraphRef.current();
					return;
				}
				if (graphRequestRef.current === requestId) setGraphLoading(false);
			});
		graphInFlightRef.current = operation;
	}, [hostGitApi, cwd, refreshStatus]);
	refreshGraphRef.current = refreshGraph;

	const handleOpenChange = (next: boolean): void => {
		onOpenChange(next);
		if (next) refreshGraph();
	};

	if (!status?.isRepository) {
		return children ? (
			<div ref={anchorRef} className={`flex h-5 shrink-0 items-stretch text-xs ${noDragRegionClassName}`}>
				{children}
			</div>
		) : null;
	}
	const branchLabel = status.currentBranch ?? `HEAD@${status.detachedHeadSha ?? "?"}`;
	const busy = busyAction !== null;

	const switchToBranch = (branch: string): Promise<void> => {
		setBusyAction(`switch:${branch}`);
		return hostGitApi
			.switchBranch({ cwd, branch })
			.then((next) => {
				setStatus(next);
				setSwitchTarget(null);
				handleOpenChange(false);
				onChanged?.();
			})
			.catch((error: unknown) => onError(formatRequestError(error)))
			.finally(() => setBusyAction(null));
	};

	const handleSwitch = (branch: string): void => {
		if (branch === status.currentBranch) {
			onOpenChange(false);
			return;
		}
		if (status.changedFiles === 0) {
			void switchToBranch(branch);
			return;
		}
		setSwitchTarget(branch);
		setSwitchMessage("");
		setBusyAction("message");
		void hostGitApi
			.generateCommitMessage(cwd)
			.then(setSwitchMessage)
			.catch((error: unknown) => onError(formatRequestError(error)))
			.finally(() => setBusyAction(null));
	};

	const commitAndSwitch = (): void => {
		const branch = switchTarget;
		if (branch === null) return;
		setBusyAction("commitSwitch");
		void hostGitApi
			.commitAll({ cwd, message: switchMessage })
			.then(() => switchToBranch(branch))
			.catch((error: unknown) => {
				onError(formatRequestError(error));
				setBusyAction(null);
			});
	};

	const createBranch = (): void => {
		setBusyAction("createBranch");
		void hostGitApi
			.createBranch({ cwd, branch: branchName, checkout: true })
			.then((next) => {
				setStatus(next);
				setGraph(null);
				setDialog(null);
				setBranchName("");
				handleOpenChange(false);
				onChanged?.();
			})
			.catch((error: unknown) => onError(formatRequestError(error)))
			.finally(() => setBusyAction(null));
	};

	return (
		<div ref={anchorRef} className={`flex h-5 shrink-0 items-stretch text-xs ${noDragRegionClassName}`}>
			<button
				type="button"
				aria-label={t("git.actions")}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={busy}
				onClick={() => handleOpenChange(!open)}
				className="flex cursor-default items-center gap-1 rounded-sm px-1.5 text-statusbar-foreground transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
			>
				<GitBranch className="size-3" aria-hidden="true" />
				<span className="max-w-[140px] truncate">{branchLabel}</span>
				{(status.ahead > 0 || status.behind > 0) && (
					<span className="font-mono text-xs tabular-nums text-warning">
						{status.ahead > 0 ? `↑${status.ahead}` : ""}
						{status.ahead > 0 && status.behind > 0 ? " " : ""}
						{status.behind > 0 ? `↓${status.behind}` : ""}
					</span>
				)}
			</button>
			{children}
			{workbenchHost &&
				createPortal(
					<GitHistoryPanel
						cwd={cwd}
						open={open}
						nestedDialogOpen={dialog !== null || switchTarget !== null}
						graph={graph}
						error={graphError}
						loading={graphLoading}
						query={query}
						currentBranch={status.currentBranch}
						busy={busy}
						onQueryChange={setQuery}
						onRefresh={refreshGraph}
						onSwitch={handleSwitch}
						onCreateBranch={() => setDialog("createBranch")}
						onOpenChange={handleOpenChange}
					/>,
					workbenchHost,
				)}

			<Dialog open={dialog === "createBranch"} onOpenChange={(next) => setDialog(next ? "createBranch" : null)}>
				<DialogContent size="compact">
					<DialogHeader>
						<DialogTitle>{t("git.createBranchTitle")}</DialogTitle>
					</DialogHeader>
					<Input
						value={branchName}
						onChange={(event) => setBranchName(event.target.value)}
						placeholder={t("worktree.branchPlaceholder")}
						className="mt-4"
					/>
					<DialogFooter className="mt-4">
						<Button type="button" variant="outline" onClick={() => setDialog(null)}>
							{t("session.cancel")}
						</Button>
						<Button type="button" onClick={createBranch} disabled={busy || branchName.trim().length === 0}>
							{t("git.createBranch")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={switchTarget !== null} onOpenChange={(next) => !next && setSwitchTarget(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("git.commitSwitchTitle")}</DialogTitle>
					</DialogHeader>
					<div className="mt-3 flex flex-col gap-1 text-xs text-text-muted">
						<div className="flex justify-between">
							<span>{t("git.commitSwitchCurrent")}</span>
							<span className="font-mono">{branchLabel}</span>
						</div>
						<div className="flex justify-between">
							<span>{t("git.commitSwitchTarget")}</span>
							<span className="font-mono">{switchTarget}</span>
						</div>
						<div className="flex justify-between">
							<span>{t("git.commitSwitchPending")}</span>
							<span className="font-mono tabular-nums">{t("changes.count", { count: status.changedFiles })}</span>
						</div>
					</div>
					<Textarea
						value={switchMessage}
						onChange={(event) => setSwitchMessage(event.target.value)}
						rows={5}
						placeholder={busyAction === "message" ? t("git.commitSwitchGenerating") : ""}
						className="mt-3 min-h-24 resize-none"
					/>
					<DialogFooter className="mt-4">
						<Button type="button" variant="outline" onClick={() => setSwitchTarget(null)}>
							{t("session.cancel")}
						</Button>
						<Button type="button" onClick={commitAndSwitch} disabled={busy || switchMessage.trim().length === 0}>
							{t("git.commitSwitchAction")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
