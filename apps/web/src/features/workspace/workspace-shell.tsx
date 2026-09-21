import { FeatureNavigationContext } from "@renderer/components/workbench/feature-navigation";
import { appPageAtom } from "@renderer/lib/navigation-state";
import { SchedulesPage } from "@renderer/features/schedules/schedules-page";
import { Button } from "@renderer/components/ui/button";
import { ReadingCloseDialog } from "./reading-close-dialog";
import { WorkbenchSlotHost } from "@renderer/components/workbench/workbench-slot-host";
import { WorkspacePanel } from "./workspace-panel";
import { ShellFrame } from "@renderer/components/shell-frame";
import { SessionExtensionEditor } from "@renderer/features/chat/extension-ui/session-extension-surfaces";
import { ReviewWorkspace } from "@renderer/features/review/review-workspace";
import { TerminalProvider } from "@renderer/features/terminal/terminal-provider";
import { useAtom, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceHome } from "./empty-state";
import { useWorkspaceRuntime, type WorkspaceShellProps } from "./use-workspace-runtime";
import { WorkspaceBanners } from "./workspace-banners";
import { WorkspaceDialogHost } from "./workspace-dialogs";
import { WorkspaceChrome, WorkspaceReadingStrip } from "./workspace-heading";
import { WorkspaceSessionStage } from "./workspace-session-stage";
import { WorkspaceShortcuts } from "./workspace-shortcuts";
import { WorkspaceSidebarNavigation } from "./workspace-sidebar";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
	workspaceSidebarAtom,
} from "./workspace-state";

function WorkspaceLayout({ overlay }: { overlay?: ReactNode }) {
	const { t } = useTranslation();
	const [appPage, setAppPage] = useAtom(appPageAtom);
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeCwd = useWorkspaceField(workspaceSelectionAtom, "activeCwd");
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	return (
		<ReviewWorkspace sessionRef={runtimeSessionRef} cwd={activeCwd}>
			<SessionExtensionEditor sessionRef={runtimeSessionRef} />

			<ShellFrame
				scene
				sidebarLabel={t("nav.navigation")}
				sidebarController={shellSidebar}
				sidebar={<WorkspaceSidebarNavigation />}
			>
				<div className="relative h-full min-h-0 w-full">
					<div
						className={`flex h-full min-h-0 flex-col ${appPage ? "invisible absolute inset-0" : ""}`}
						inert={!!appPage}
					>
						{activeSessionRef ? <WorkspaceSessionStage /> : <WorkspaceHomeStage />}
					</div>
					{appPage === "schedules" && (
						<div className="flex h-full min-h-0 flex-col">
							<div className="flex h-10 shrink-0 items-center px-4">
								<Button size="sm" variant="ghost" onClick={() => setAppPage(null)}>
									{t("palette.backToWorkspace")}
								</Button>
							</div>
							<SchedulesPage />
						</div>
					)}
				</div>
			</ShellFrame>

			<WorkspaceDialogHost />
			<ReadingCloseDialog />
			{overlay}
		</ReviewWorkspace>
	);
}

function WorkspaceHomeStage() {
	const { sideMode, open, close, toggleSidePanel } = useWorkspaceOwner(workspacePanelAtom);
	return (
		<WorkbenchSlotHost
			chrome={<WorkspaceChrome />}
			readingHeader={<WorkspaceReadingStrip />}
			top={<WorkspaceBanners />}
			main={<WorkspaceHome />}
			bottom={(main) => main}
			rightOpen={open}
			side={sideMode === null ? null : <WorkspacePanel />}
			onSideClose={close}
			onSideToggle={toggleSidePanel}
			shortcuts={<WorkspaceShortcuts />}
			overlay={null}
		/>
	);
}

export function WorkspaceShell({ overlay, ...props }: WorkspaceShellProps & { overlay?: ReactNode }) {
	return (
		<TerminalProvider>
			<WorkspaceNavigation {...props}>
				<WorkspaceLayout overlay={overlay} />
			</WorkspaceNavigation>
		</TerminalProvider>
	);
}

function WorkspaceNavigation({ children, ...props }: WorkspaceShellProps & { children: ReactNode }) {
	useWorkspaceRuntime(props);
	const ready = useAtomValue(workspaceSelectionAtom);
	const tabs = useAtomValue(workspaceTabsAtom);
	return ready === null || tabs === null ? null : (
		<FeatureNavigationContext value={tabs.openFeatureViewer}>{children}</FeatureNavigationContext>
	);
}
