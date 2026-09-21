import { DataHealthLink } from "@renderer/components/data-health/data-health";
import { Button } from "@renderer/components/ui/button";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ProjectPickerProps {
	storeError: string | null;
	storePersistenceError: string | null;
	loadError: string | null;
	onRetryLoad: () => void;
	onAddProject: () => void;
}

export function ProjectPicker({
	storeError,
	storePersistenceError,
	loadError,
	onRetryLoad,
	onAddProject,
}: ProjectPickerProps) {
	const { t } = useTranslation();

	return (
		<div className="view-fade-in flex h-full w-full flex-col items-center justify-center gap-4 text-text-primary">
			<FolderOpen className="size-10 text-text-muted" aria-hidden="true" />
			{storeError ? (
				<>
					<div className="flex flex-col items-center gap-1 text-center">
						<h1 className="text-sm font-semibold">{t("project.storeReadErrorTitle")}</h1>
						<p className="max-w-md text-xs text-text-muted">
							{t("project.storeReadErrorDescription", { message: storeError })}
						</p>
					</div>
					<DataHealthLink />
				</>
			) : storePersistenceError ? (
				<>
					<div className="flex flex-col items-center gap-1 text-center">
						<h1 className="text-sm font-semibold">{t("project.storeWriteErrorTitle")}</h1>
						<p className="max-w-md text-xs text-text-muted">{storePersistenceError}</p>
					</div>
					<DataHealthLink />
				</>
			) : loadError ? (
				<>
					<div className="flex flex-col items-center gap-1 text-center">
						<h1 className="text-sm font-semibold">{t("project.loadErrorTitle")}</h1>
						<p className="max-w-md text-xs text-text-muted">
							{t("project.loadErrorDescription", { message: loadError })}
						</p>
					</div>
					<Button onClick={onRetryLoad}>{t("project.loadRetry")}</Button>
				</>
			) : (
				<>
					<div className="flex flex-col items-center gap-1 text-center">
						<h1 className="text-sm font-semibold">{t("project.title")}</h1>
						<p className="max-w-xs text-xs text-text-muted">{t("project.description")}</p>
					</div>
					<Button onClick={onAddProject}>{t("project.choose")}</Button>
				</>
			)}
		</div>
	);
}
