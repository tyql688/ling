import type { HostDirectoryListing } from "@ling/contracts/project";
import type { HostApi } from "@ling/contracts/api/host-procedures";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { FormField } from "@renderer/components/ui/form-field";
import { Input } from "@renderer/components/ui/input";
import { formatRequestError } from "@renderer/lib/errors";
import { ArrowUp, ChevronRight, Folder, House } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function HostDirectoryPicker({
	home,
	browseDirectory,
	onFinish,
}: {
	home: string | null;
	browseDirectory: HostApi["project"]["browseDirectories"];
	onFinish(value: string | null): void;
}) {
	const { t } = useTranslation();
	const [path, setPath] = useState(home ?? "");
	const [location, setLocation] = useState(home === null ? null : { path: home });
	const [listing, setListing] = useState<HostDirectoryListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(home !== null);
	const [showHidden, setShowHidden] = useState(false);
	useEffect(() => {
		if (location === null) return;
		let active = true;
		setBusy(true);
		setListing(null);
		setError(null);
		void browseDirectory(location.path).then(
			(result) => {
				if (!active) return;
				setListing(result);
				setPath((current) => (current === location.path ? result.path : current));
				setBusy(false);
			},
			(failure: unknown) => {
				if (!active) return;
				setError(formatRequestError(failure));
				setBusy(false);
			},
		);
		return () => {
			active = false;
		};
	}, [browseDirectory, location]);
	const navigate = (target: string) => {
		setPath(target);
		setLocation({ path: target });
	};
	const entries = listing?.entries.filter((entry) => showHidden || !entry.name.startsWith("."));
	return (
		<Dialog open onOpenChange={(open) => !open && onFinish(null)}>
			<DialogContent className="flex flex-col gap-4 overflow-y-auto">
				<DialogTitle>{t("project.hostPathTitle")}</DialogTitle>
				<DialogDescription>{t("project.hostPathDescription")}</DialogDescription>
				<form
					className="flex min-w-0 items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (path.trim()) navigate(path.trim());
					}}
				>
					<FormField label={t("project.hostPathLabel")} className="min-w-0 flex-1">
						<Input
							required
							name="projectPath"
							autoComplete="off"
							spellCheck={false}
							value={path}
							onChange={(event) => setPath(event.target.value)}
							onFocus={(event) => event.target.select()}
							placeholder={t("project.hostPathPlaceholder")}
							className="font-mono"
						/>
					</FormField>
					<Button type="submit" variant="outline" disabled={busy || !path.trim()}>
						{t("project.hostPathGo")}
					</Button>
				</form>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" disabled={home === null} onClick={() => home !== null && navigate(home)}>
						<House className="size-3.5" aria-hidden="true" />
						{t("project.hostPathHome")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!listing?.parent}
						onClick={() => listing?.parent && navigate(listing.parent)}
					>
						<ArrowUp className="size-3.5" aria-hidden="true" />
						{t("project.hostPathParent")}
					</Button>
					<Button variant="ghost" size="sm" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}>
						{t("project.hostPathHidden")}
					</Button>
				</div>
				{error && <FeedbackNotice tone="danger">{error}</FeedbackNotice>}
				<div className="min-h-20 max-h-60 overflow-y-auto divide-y divide-border-subtle" aria-busy={busy}>
					{busy && (
						<p role="status" className="py-4 text-sm text-text-muted">
							{t("common.loading")}
						</p>
					)}
					{entries?.length === 0 && <p className="py-4 text-sm text-text-muted">{t("project.hostPathEmpty")}</p>}
					{entries?.map((entry) => (
						<Button
							key={entry.path}
							variant="ghost"
							className="h-auto min-h-9 w-full justify-start gap-2 py-2 text-left"
							disabled={entry.unavailable}
							onClick={() => navigate(entry.path)}
						>
							<Folder className="size-4 shrink-0" aria-hidden="true" />
							<span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{entry.name}</span>
							{entry.unavailable ? (
								<span className="text-xs">{t("project.hostPathUnavailable")}</span>
							) : (
								<ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
							)}
						</Button>
					))}
				</div>
				{listing?.truncated && <FeedbackNotice>{t("project.hostPathTruncated")}</FeedbackNotice>}
				<DialogFooter className="flex-wrap">
					<Button variant="outline" onClick={() => onFinish(null)}>
						{t("session.cancel")}
					</Button>
					<Button
						disabled={busy || listing === null || path !== listing.path}
						onClick={() => listing && onFinish(listing.path)}
					>
						{t("project.hostPathSelect")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
