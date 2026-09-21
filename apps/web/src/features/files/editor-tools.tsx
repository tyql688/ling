import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@renderer/components/ui/dialog";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { MonacoConflictDiff } from "./monaco-conflict-diff";
import type { EditorFeatures } from "./use-editor-features";

export function EditorContextMenu({
	features,
	children,
	hidden = false,
}: {
	features: EditorFeatures;
	children: ReactNode;
	hidden?: boolean;
}) {
	const selectedAction = useRef<EditorFeatures["actions"][number] | null>(null);
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					className={hidden ? "hidden" : "min-h-0 flex-1 flex flex-col"}
					onContextMenu={(event) => event.stopPropagation()}
				>
					{children}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent
				className="max-h-[75vh] overflow-auto min-w-56"
				onCloseAutoFocus={(event) => {
					const action = selectedAction.current;
					selectedAction.current = null;
					if (!action) return;
					// Closing Radix must finish before Monaco opens its own focused widget.
					event.preventDefault();
					features.execute(action);
				}}
			>
				{features.actions.map((action) => (
					<div key={action.id}>
						{action.separateBefore && <ContextMenuSeparator />}
						<ContextMenuItem
							disabled={action.disabled ?? false}
							onSelect={() => {
								selectedAction.current = action;
							}}
						>
							{action.title}
						</ContextMenuItem>
					</div>
				))}
			</ContextMenuContent>
		</ContextMenu>
	);
}
export function EditorDialogs({ features }: { features: EditorFeatures }) {
	const { t } = useTranslation(),
		proposal = features.proposal,
		selected = proposal?.files[features.selectedFile];
	return (
		<>
			<Dialog
				open={proposal !== null}
				onOpenChange={(open) => {
					if (!open) features.finishReview(false);
				}}
			>
				<DialogContent className="flex h-[min(80vh,850px)] w-[min(92vw,1200px)] max-w-none flex-col gap-3 p-4">
					<DialogTitle>{t("editor.reviewTitle", { title: proposal?.label ?? "" })}</DialogTitle>
					<DialogDescription>{t("editor.reviewDescription")}</DialogDescription>
					<div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border-subtle">
						{proposal && proposal.files.length > 1 && (
							<nav
								className="w-48 shrink-0 overflow-auto border-r border-border-subtle p-1"
								aria-label={t("editor.changedFiles")}
							>
								{proposal.files.map((file, index) => (
									<button
										key={file.path}
										type="button"
										onClick={() => features.setSelectedFile(index)}
										className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${index === features.selectedFile ? "bg-surface-hover text-text-primary" : "text-text-muted"}`}
										title={file.path}
									>
										{file.path}
									</button>
								))}
							</nav>
						)}
						<div className="min-w-0 flex-1 flex flex-col">
							{selected && (
								<>
									<div className="border-b border-border-subtle px-3 py-2 text-xs text-text-muted">{selected.path}</div>
									<MonacoConflictDiff path={selected.path} local={selected.before} disk={selected.after} />
								</>
							)}
						</div>
					</div>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => features.finishReview(false)}>
							{t("common.cancel")}
						</Button>
						<Button onClick={() => features.finishReview(true)}>{t("editor.applyEdits")}</Button>
					</div>
				</DialogContent>
			</Dialog>
			<Dialog open={features.symbolsOpen} onOpenChange={features.setSymbolsOpen}>
				<DialogContent className="gap-3 max-w-xl">
					<DialogTitle>{t("editor.workspaceSymbols")}</DialogTitle>
					<DialogDescription>{t("editor.workspaceSymbolsDescription")}</DialogDescription>
					<Input
						value={features.symbolQuery}
						onChange={(event) => features.setSymbolQuery(event.target.value)}
						placeholder={t("editor.symbolQuery")}
					/>
					<div className="max-h-[50vh] overflow-auto">
						{features.symbolsLoading ? (
							<p className="p-3 text-sm text-text-muted">{t("common.loading")}</p>
						) : (
							features.symbols.map((symbol) => (
								<button
									type="button"
									key={`${symbol.location.uri}:${symbol.location.range.start.line}:${symbol.location.range.start.character}:${symbol.name}`}
									onClick={() => features.openSymbol(symbol)}
									className="flex w-full min-w-0 items-center justify-between gap-3 rounded px-3 py-2 text-sm hover:bg-surface-hover"
								>
									<span className="truncate">{symbol.name}</span>
									<span className="truncate text-xs text-text-muted">{symbol.containerName}</span>
								</button>
							))
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
