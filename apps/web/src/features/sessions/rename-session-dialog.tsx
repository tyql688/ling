import { SESSION_TITLE_MAX_CHARS } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { useBoundedTextInput } from "@renderer/hooks/use-bounded-text-input";
import { useImeGuard } from "@renderer/hooks/use-ime-guard";
import { formatRequestError } from "@renderer/lib/errors";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

/** Rename from a session actions menu — the sidebar keeps its inline edit; this
 * dialog covers surfaces without an editable title field. */
export function RenameSessionDialog({
	target,
	onClose,
	onRename,
}: {
	target: { ref: SessionRef; title: string } | null;
	onClose: () => void;
	onRename: (ref: SessionRef, title: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const limitErrorId = useId();
	const [value, setValueState] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const { limitExceeded, setBoundedValue: setValue } = useBoundedTextInput(setValueState, SESSION_TITLE_MAX_CHARS);
	const ime = useImeGuard();

	useEffect(() => {
		ime.resetComposition();
		if (target === null) return;
		setValueState(target.title);
		setError(null);
	}, [ime, target]);

	const submit = () => {
		ime.resetComposition();
		if (target === null) return;
		const trimmed = value.trim();
		if (trimmed.length === 0 || trimmed === target.title) {
			onClose();
			return;
		}
		setSaving(true);
		setError(null);
		void onRename(target.ref, trimmed)
			.then(onClose)
			.catch((cause: unknown) => setError(formatRequestError(cause)))
			.finally(() => setSaving(false));
	};

	return (
		<Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent size="compact">
				<DialogHeader>
					<DialogTitle>{t("session.renameDialogTitle")}</DialogTitle>
				</DialogHeader>
				<Input
					aria-label={t("session.renameInputLabel")}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (ime.isComposing(event)) return;
						if (event.key === "Enter") submit();
					}}
					{...ime.compositionProps}
					aria-invalid={limitExceeded}
					aria-errormessage={limitExceeded ? limitErrorId : undefined}
					className="mt-4"
				/>
				{limitExceeded && (
					<FeedbackNotice id={limitErrorId} tone="danger" className="mt-2 text-xs">
						{t("session.titleTextLimit", { count: SESSION_TITLE_MAX_CHARS })}
					</FeedbackNotice>
				)}
				{error && (
					<FeedbackNotice tone="danger" className="mt-2 text-xs">
						<p className="whitespace-pre-wrap">{error}</p>
					</FeedbackNotice>
				)}
				<DialogFooter className="mt-4">
					<Button type="button" variant="outline" onClick={onClose}>
						{t("session.cancel")}
					</Button>
					<Button type="button" onClick={submit} disabled={saving || value.trim().length === 0}>
						{t("session.renameDialogAction")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
