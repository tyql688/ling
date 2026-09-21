import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectPiConfig } from "@ling/contracts/project";
import { Button } from "@renderer/components/ui/button";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { WorkbenchDialog } from "@renderer/components/workbench-dialog";
import { formatRequestError } from "@renderer/lib/errors";
import { tildify } from "@renderer/lib/format-path";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type LoadState =
	{ kind: "loading" } | { kind: "loaded"; config: ProjectPiConfig } | { kind: "failed"; message: string };

/**
 * Read-only view of a project's own `.pi/settings.json`.
 *
 * Pi merges project settings over global ones for every field, so a value here silently wins
 * over anything set in Pi Settings — including machine-level keys such as `shellPath`. That is
 * exactly why this panel exists: without it a user edits a global setting, sees it saved, and
 * has no way to find out why nothing changed.
 */
export function ProjectPiConfigPanel({
	cwd,
	open,
	onOpenChange,
	docked,
}: {
	cwd: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Inline in the workspace side panel (no dialog chrome). */
	docked?: boolean | undefined;
}) {
	const hostProjectApi = useDomainApi("project");

	const { t } = useTranslation();
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(() => {
		let cancelled = false;
		setState({ kind: "loading" });
		hostProjectApi
			.piConfig(cwd)
			.then((config) => {
				if (!cancelled) setState({ kind: "loaded", config });
			})
			.catch((error: unknown) => {
				if (!cancelled) setState({ kind: "failed", message: formatRequestError(error, t) });
			});
		return () => {
			cancelled = true;
		};
	}, [hostProjectApi, cwd, t]);

	// Re-read on every open: the file is edited outside Ling, so a cached copy would go stale
	// without any event to invalidate it.
	useEffect(() => {
		if (!open) return;
		return load();
	}, [open, load]);

	return (
		<WorkbenchDialog
			docked={docked}
			open={open}
			nestedDialogOpen={false}
			title={t("projectPiConfig.title")}
			description={t("projectPiConfig.description")}
			onOpenChange={onOpenChange}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
				<div className="flex items-center gap-2">
					<code className="min-w-0 flex-1 truncate rounded-control bg-surface-raised px-2 py-1 font-mono text-xs text-text-muted">
						{state.kind === "loaded" ? tildify(state.config.path) : tildify(`${cwd}/.pi/settings.json`)}
					</code>
					<Button variant="outline" size="sm" onClick={load} disabled={state.kind === "loading"}>
						<RefreshCw className="size-3.5" aria-hidden="true" />
						{t("projectPiConfig.refresh")}
					</Button>
				</div>

				{state.kind === "loading" && <LoadingTransition label={t("projectPiConfig.loading")} />}
				{state.kind === "failed" && <p className="text-sm text-danger">{state.message}</p>}
				{state.kind === "loaded" && <ProjectPiConfigBody config={state.config} />}
			</div>
		</WorkbenchDialog>
	);
}

function ProjectPiConfigBody({ config }: { config: ProjectPiConfig }) {
	const { t } = useTranslation();

	// Pi hands back an empty object for an untrusted project and for a missing file alike, so
	// these three states must be told apart here or an empty panel is unexplainable.
	if (!config.trusted) {
		return (
			<div className="flex items-start gap-2 rounded-control border border-warning/40 bg-warning/8 p-3">
				<ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
				<div className="min-w-0 text-sm">
					<p className="font-medium text-text-primary">{t("projectPiConfig.untrustedTitle")}</p>
					<p className="mt-1 text-text-muted">{t("projectPiConfig.untrustedDescription")}</p>
				</div>
			</div>
		);
	}

	if (!config.exists) {
		return <p className="text-sm text-text-muted">{t("projectPiConfig.missing")}</p>;
	}

	const keys = Object.keys(config.settings);
	if (keys.length === 0) {
		return <p className="text-sm text-text-muted">{t("projectPiConfig.empty")}</p>;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<p className="text-xs text-text-muted">{t("projectPiConfig.overrideNotice", { count: keys.length })}</p>
			<pre className="min-h-0 flex-1 overflow-auto rounded-control border border-border-subtle bg-surface-raised p-3 font-mono text-xs text-text-primary">
				{JSON.stringify(config.settings, null, 2)}
			</pre>
		</div>
	);
}
