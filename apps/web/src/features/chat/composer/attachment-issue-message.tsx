import { PROJECT_FILE_REFERENCE_MAX_ITEMS } from "@ling/contracts/project";
import { SESSION_IMAGE_MAX_BYTES, SESSION_IMAGE_MAX_ITEMS } from "@ling/contracts/session";
import { ComposerInlineAlert } from "@renderer/features/chat/composer/composer-shell";
import type { FileReferenceIssue } from "@renderer/features/chat/composer/use-composer-attachments";
import {
	type AttachmentIssue,
	MAX_DRAFT_IMAGE_DATA_URL_BYTES,
} from "@renderer/features/sessions/state/image-attachment-policy";
import { useTranslation } from "react-i18next";

interface AttachmentIssueMessageProps {
	issue: AttachmentIssue | null;
	className?: string;
}

/** MiB conversion factor; attachment-limit copy uses binary mebibytes, matching the main-process byte cap. */
const BYTES_PER_MEBIBYTE = 1024 * 1024;

export function AttachmentIssueMessage({ issue, className }: AttachmentIssueMessageProps) {
	const { t } = useTranslation();
	if (!issue) return null;

	let message: string;
	switch (issue.code) {
		case "count":
			message = t("session.attachmentLimitCount", { count: SESSION_IMAGE_MAX_ITEMS });
			break;
		case "file-size":
			message = t("session.attachmentLimitFileSize", {
				name: issue.fileName,
				size: SESSION_IMAGE_MAX_BYTES / BYTES_PER_MEBIBYTE,
			});
			break;
		case "unsupported-type":
			message = t("session.attachmentUnsupportedType");
			break;
		case "total-size":
			message = t("session.attachmentLimitTotalSize", {
				size: MAX_DRAFT_IMAGE_DATA_URL_BYTES / BYTES_PER_MEBIBYTE,
			});
			break;
		case "read-failed":
			message = t("session.attachmentReadFailed", { name: issue.fileName });
			break;
	}

	return <ComposerInlineAlert message={message} className={className} />;
}

export function FileReferenceIssueMessage({
	issue,
	className,
}: {
	issue: FileReferenceIssue | null;
	className?: string | undefined;
}) {
	const { t } = useTranslation();
	if (issue === null) return null;
	const message =
		issue.code === "count"
			? t("session.fileReferenceLimit", { count: PROJECT_FILE_REFERENCE_MAX_ITEMS })
			: issue.code === "resolve-failed"
				? t("session.fileReferenceResolveFailed")
				: t("session.filePathUnavailable", { name: issue.fileName });
	return <ComposerInlineAlert message={message} className={className} />;
}
