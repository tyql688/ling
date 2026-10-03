import { WorkbenchDialog } from "@renderer/components/workbench-dialog";
import { PiConfigurationEditor } from "@renderer/features/settings/pi-configuration-editor";
import { useTranslation } from "react-i18next";

/** Project settings use the same scoped editor as the Pi settings page. */
export function ProjectPiConfigPanel({
	cwd,
	open,
	onOpenChange,
	docked,
}: {
	cwd: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	docked?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<WorkbenchDialog
			docked={docked}
			open={open}
			nestedDialogOpen={false}
			title={t("projectPiConfig.title")}
			description={t("projectPiConfig.description")}
			onOpenChange={onOpenChange}
		>
			<div className="min-h-0 flex-1 overflow-auto p-4">{open && <PiConfigurationEditor key={cwd} cwd={cwd} />}</div>
		</WorkbenchDialog>
	);
}
