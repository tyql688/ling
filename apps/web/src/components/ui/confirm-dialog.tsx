import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	confirmLabel: string;
	cancelLabel: string;
	destructive?: boolean;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	open,
	title,
	confirmLabel,
	cancelLabel,
	destructive,
	busy = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onCancel();
			}}
		>
			{open && (
				<DialogContent size="compact">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					<DialogFooter className="mt-4">
						<Button variant="outline" disabled={busy} onClick={onCancel}>
							{cancelLabel}
						</Button>
						<Button variant={destructive ? "danger" : "default"} disabled={busy} onClick={onConfirm}>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
}
