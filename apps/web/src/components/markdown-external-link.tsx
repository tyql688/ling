import { useDomainApi } from "@renderer/lib/host-api-context";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { COPY_CHECK_CLASS, useCopyFeedback } from "@renderer/hooks/use-copy-feedback";
import { formatRequestError } from "@renderer/lib/errors";
import { cn } from "@renderer/lib/utils";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** One mounted dialog owns one URL and its pending clipboard/browser actions. */
export function MarkdownExternalLinkDialog({ onClose, url }: { onClose: () => void; url: string }) {
	const hostAppApi = useDomainApi("app");

	const { t } = useTranslation();
	const { copiedKey: copied, markCopied } = useCopyFeedback<true>();
	const [actionError, setActionError] = useState<string | null>(null);
	const active = useRef(false);
	useLayoutEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	const close = () => {
		active.current = false;
		onClose();
	};
	const copyLink = async () => {
		try {
			await navigator.clipboard.writeText(url);
			if (!active.current) return;
			markCopied(true);
			setActionError(null);
		} catch (error) {
			if (active.current) setActionError(formatRequestError(error, t));
		}
	};
	const openLink = async () => {
		try {
			await hostAppApi.openExternal(url);
			if (active.current) close();
		} catch (error) {
			if (active.current) setActionError(formatRequestError(error, t));
		}
	};

	return (
		<Dialog open onOpenChange={(next) => !next && close()}>
			<DialogContent size="compact">
				<DialogCloseButton aria-label={t("markdown.close")} />
				<DialogHeader className="pr-8">
					<DialogTitle className="flex items-center gap-2">
						<ExternalLink className="size-4" aria-hidden="true" />
						{t("markdown.openExternalLink")}
					</DialogTitle>
					<DialogDescription>{t("markdown.externalLinkWarning")}</DialogDescription>
				</DialogHeader>
				<pre className="my-4 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface-raised p-3 font-mono text-sm text-text-primary">
					{url}
				</pre>
				{actionError && (
					<FeedbackNotice tone="danger" className="mb-4 text-xs">
						{actionError}
					</FeedbackNotice>
				)}
				<DialogFooter className="grid grid-cols-2">
					<Button type="button" variant="outline" onClick={() => void copyLink()}>
						{copied ? (
							<Check className={cn("size-4", COPY_CHECK_CLASS)} aria-hidden="true" />
						) : (
							<Copy className="size-4" aria-hidden="true" />
						)}
						{copied ? t("markdown.copied") : t("markdown.copyLink")}
					</Button>
					<Button type="button" onClick={() => void openLink()}>
						<ExternalLink className="size-4" aria-hidden="true" />
						{t("markdown.openLink")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
