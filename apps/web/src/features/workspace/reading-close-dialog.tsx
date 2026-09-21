import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { useWorkspaceOwner, workspaceTabsAtom } from "./workspace-state";

export function ReadingCloseDialog() {
	const { t } = useTranslation();
	const { pendingClose, closing, resolveClose } = useWorkspaceOwner(workspaceTabsAtom);
	return (
		<Dialog
			open={pendingClose !== null}
			onOpenChange={(open) => {
				if (!open) void resolveClose("cancel");
			}}
		>
			{pendingClose !== null && (
				<DialogContent
					size="compact"
					onEscapeKeyDown={(event) => {
						if (closing) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>{t("reading.unsavedTitle")}</DialogTitle>
						<DialogDescription>{t("reading.unsavedDescription")}</DialogDescription>
					</DialogHeader>
					<ul className="max-h-40 overflow-auto text-sm text-text-muted">
						{pendingClose.paths.map((path) => (
							<li key={path} className="truncate" title={path}>
								{path}
							</li>
						))}
					</ul>
					<DialogFooter>
						<Button variant="outline" disabled={closing} onClick={() => void resolveClose("cancel")}>
							{t("session.cancel")}
						</Button>
						<Button variant="ghost" disabled={closing} onClick={() => void resolveClose("discard")}>
							{t("reading.discardClose")}
						</Button>
						<Button disabled={closing} onClick={() => void resolveClose("save")}>
							{t("reading.saveClose")}
						</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
}
