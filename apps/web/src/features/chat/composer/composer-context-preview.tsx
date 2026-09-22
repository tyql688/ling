import type { DraftContext } from "@renderer/features/sessions/state/draft-context";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { Button } from "@renderer/components/ui/button";
import { useTranslation } from "react-i18next";

export function ComposerContextPreview({
	context,
	label,
	onClose,
	onExpand,
}: {
	context: Extract<DraftContext, { kind: "paste" | "review" }> | null;
	label: string;
	onClose: () => void;
	onExpand: () => void;
}) {
	const { t } = useTranslation();
	const text =
		context?.kind === "paste"
			? context.value.text
			: context?.kind === "review"
				? `${context.value.filePath} ${context.value.rangeLabel}\n${context.value.text}\n${context.value.excerpt}`
				: null;
	return (
		<Dialog
			open={text !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			{text !== null && (
				<DialogContent size="large">
					<div className="flex max-h-[70vh] flex-col gap-3">
						<DialogHeader>
							<DialogTitle className="text-sm">{label}</DialogTitle>
						</DialogHeader>
						<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-raised p-3 font-mono text-xs leading-relaxed text-text-primary">
							{text}
						</pre>
						{context?.kind === "paste" && (
							<Button variant="outline" className="self-end" onClick={onExpand}>
								{t("composerFormat.expandPaste")}
							</Button>
						)}
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}
