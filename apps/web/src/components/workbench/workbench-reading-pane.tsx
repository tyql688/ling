import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { PanelRight } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WorkbenchDivider } from "./workbench-divider";
import { DEFAULT_GEOMETRY } from "./workbench-geometry";
import { WorkbenchLayoutContext } from "./workbench-layout-context";

/** Files, changes and skills share one content surface and a resizable navigator on its right. */
export function WorkbenchReadingPane({
	children,
	navigation = null,
	navigationLabel,
	selectionKey,
}: {
	children: ReactNode;
	navigation?: ReactNode;
	navigationLabel?: string;
	selectionKey?: string | null | undefined;
}) {
	const { t } = useTranslation();
	const layout = useContext(WorkbenchLayoutContext);
	const rootRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [localWidth, setLocalWidth] = useState(DEFAULT_GEOMETRY.sidebar);
	const [navigationOpen, setNavigationOpen] = useState(false);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const measure = () => setWidth(root.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);
	useEffect(() => setNavigationOpen(false), [selectionKey]);
	// A docked navigator keeps 240px and leaves at least 340px for readable content.
	const narrow = width > 0 && width < 580;
	const preferredWidth = layout?.navigationWidth ?? localWidth;
	const navigationWidth = navigation !== null && !narrow ? Math.min(preferredWidth, Math.max(240, width - 340)) : 0;
	const reportWidth = layout?.setDockedNavigationWidth;
	useLayoutEffect(() => {
		reportWidth?.(navigationWidth);
		return () => reportWidth?.(0);
	}, [navigationWidth, reportWidth]);
	const resize = (next: number, persist: boolean) => {
		if (layout) layout.resizeNavigation(next, persist);
		else setLocalWidth(next);
	};
	const showNavigation = navigation !== null && narrow && navigationOpen;
	return (
		<div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			{navigation !== null && narrow && (
				<div className="flex shrink-0 justify-end border-b border-border-subtle bg-workbench-surface px-2 py-1">
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={showNavigation}
						onClick={() => setNavigationOpen(!navigationOpen)}
					>
						<PanelRight className="size-3.5" aria-hidden="true" />
						{t(showNavigation ? "reading.showContent" : "reading.showNavigation")}
					</Button>
				</div>
			)}
			<div className="relative flex min-h-0 min-w-0 flex-1">
				<div
					inert={showNavigation}
					className={cn(
						"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface",
						showNavigation && "invisible absolute inset-0",
					)}
					style={{ marginRight: navigationWidth, paddingBottom: layout?.contentBottomInset ?? 0 }}
				>
					{children}
				</div>
				{navigation !== null && (
					<>
						{!narrow && (
							<WorkbenchDivider
								label={t("nav.resizeSidePanel")}
								value={navigationWidth}
								min={240}
								max={Math.max(240, Math.min(600, width - 340))}
								direction={-1}
								onChange={(next) => resize(next, false)}
								onCommit={(next) => resize(next, true)}
								onReset={() => resize(DEFAULT_GEOMETRY.sidebar, true)}
								style={{ right: navigationWidth }}
							/>
						)}
						<aside
							aria-label={navigationLabel}
							data-workspace-context-sidebar=""
							inert={narrow && !showNavigation}
							className={cn(
								"workspace-side-surface absolute inset-y-0 right-0 flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border-subtle bg-workbench-side",
								narrow && !showNavigation && "invisible",
							)}
							style={{ width: narrow ? "100%" : navigationWidth }}
						>
							{navigation}
						</aside>
					</>
				)}
			</div>
		</div>
	);
}
