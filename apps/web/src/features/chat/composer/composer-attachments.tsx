import { attachmentFileUrl, attachmentMediaKind, attachmentMediaType } from "@ling/contracts/attachments";
import type { PendingFileReference } from "@ling/contracts/draft";
import type { PendingAttachment } from "@renderer/features/sessions/state/image-attachment-policy";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { File, Folder, ImageOff, LoaderCircle, Music, Play, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface AttachmentPreview {
	id: string;
	name: string;
	src: string | null;
	kind: "image" | "video" | "audio" | null;
	reference?: PendingFileReference;
}

function AttachmentCard({
	item,
	onOpen,
	onRemove,
}: {
	item: AttachmentPreview;
	onOpen: () => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	const [failed, setFailed] = useState(false);
	const Icon = failed
		? ImageOff
		: item.reference?.directory
			? Folder
			: item.kind === "video"
				? Play
				: item.kind === "audio"
					? Music
					: File;
	return (
		<div className="relative w-32 shrink-0">
			<Button
				type="button"
				variant="outline"
				size={null}
				onClick={onOpen}
				title={item.reference?.path ?? item.name}
				aria-label={t("session.previewAttachment", { name: item.name })}
				className="h-28 w-full flex-col gap-0 overflow-hidden bg-surface-raised font-normal text-text-secondary hover:bg-surface-hover"
			>
				<span className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
					{!failed && item.kind === "image" && item.src ? (
						<img src={item.src} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
					) : (
						<Icon className="size-7" aria-hidden="true" />
					)}
				</span>
				<span className="w-full truncate px-2 py-1 text-xs">{item.name}</span>
			</Button>
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="absolute -end-1 -top-1 size-6 rounded-full bg-surface-raised"
				aria-label={t("session.removeAttachment", { name: item.name })}
				onClick={onRemove}
			>
				<X className="size-3.5" aria-hidden="true" />
			</Button>
		</div>
	);
}

/** Media belongs to the draft, independently of the text editor and its undo history. */
export function ComposerAttachments({
	cwd,
	images,
	files,
	pending,
	onRemoveImage,
	onRemoveFile,
	onOpenFile,
}: {
	cwd: string | null;
	images: readonly PendingAttachment[];
	files: readonly PendingFileReference[];
	pending?: boolean;
	onRemoveImage(id: string): void;
	onRemoveFile(id: string): void;
	onOpenFile?: (reference: PendingFileReference) => boolean;
}) {
	const { t } = useTranslation();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [previewFailed, setPreviewFailed] = useState(false);
	const items: AttachmentPreview[] = [
		...files.map((reference) => ({
			id: reference.id,
			name:
				reference.path
					.split(/[/\\]/)
					.at(-1)
					?.replace(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-/, "") ?? reference.path,
			src: cwd && !reference.directory ? attachmentFileUrl(cwd, reference) : null,
			kind: reference.directory ? null : attachmentMediaKind(attachmentMediaType(reference.path)),
			reference,
		})),
		...images.map((image) => ({
			id: image.id,
			name: image.name || t("composerFormat.image"),
			src: image.dataUrl,
			kind: "image" as const,
		})),
	];
	const selected = items.find((item) => item.id === selectedId);
	if (items.length === 0 && !pending) return null;
	return (
		<>
			<div
				className="flex max-h-64 flex-wrap gap-3 overflow-y-auto p-1"
				role="group"
				aria-label={t("session.attachments")}
			>
				{items.map((item) => (
					<AttachmentCard
						key={item.id}
						item={item}
						onRemove={() => (item.reference ? onRemoveFile(item.id) : onRemoveImage(item.id))}
						onOpen={() => {
							if (!item.kind && item.reference && onOpenFile?.(item.reference)) return;
							setPreviewFailed(false);
							setSelectedId(item.id);
						}}
					/>
				))}
			</div>
			<div role="status" className="text-xs text-text-muted">
				{pending && (
					<span className="flex items-center gap-2">
						<LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
						{t("session.addingAttachments")}
					</span>
				)}
			</div>
			<Dialog
				open={selected !== undefined}
				onOpenChange={(open) => {
					if (!open) setSelectedId(null);
				}}
			>
				{selected && (
					<DialogContent size="large">
						<DialogHeader>
							<DialogTitle className="break-words">{selected.name}</DialogTitle>
						</DialogHeader>
						{!previewFailed && selected.src && selected.kind === "image" ? (
							<img
								src={selected.src}
								alt={selected.name}
								className="max-h-[65vh] max-w-full self-center object-contain"
								onError={() => setPreviewFailed(true)}
							/>
						) : !previewFailed && selected.src && selected.kind === "video" ? (
							// eslint-disable-next-line jsx-a11y/media-has-caption -- User attachments do not supply caption tracks.
							<video
								src={selected.src}
								controls
								playsInline
								preload="metadata"
								className="max-h-[65vh] w-full"
								onError={() => setPreviewFailed(true)}
							/>
						) : !previewFailed && selected.src && selected.kind === "audio" ? (
							// eslint-disable-next-line jsx-a11y/media-has-caption -- User attachments do not supply caption tracks.
							<audio
								src={selected.src}
								controls
								preload="metadata"
								className="w-full"
								onError={() => setPreviewFailed(true)}
							/>
						) : (
							<p className="text-sm text-text-secondary">{t("session.attachmentPreviewUnavailable")}</p>
						)}
						{selected.src && (
							<a
								href={selected.reference && cwd ? attachmentFileUrl(cwd, selected.reference, true) : selected.src}
								download={selected.name}
								className="self-start rounded-control text-sm text-accent underline"
							>
								{t("session.downloadAttachment")}
							</a>
						)}
					</DialogContent>
				)}
			</Dialog>
		</>
	);
}
