import { useDomainApi } from "@renderer/lib/host-api-context";
import { SKILL_RESOURCE_CONTENT_MAX_BYTES, type SkillResourceInfo } from "@ling/contracts/skill";
import { Markdown } from "@renderer/components/markdown";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { SettingsCollection } from "@renderer/components/ui/settings-list";
import { SettingsRetryAction } from "@renderer/components/ui/settings-state";
import { tildify } from "@renderer/lib/format-path";
import { cn } from "@renderer/lib/utils";
import { useStableCallback } from "@renderer/hooks/use-stable-callback";
import { useEffect, useLayoutEffect, useRef } from "react";
import { ExternalLink, FileCode2, FileText, GraduationCap, Image } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkillScopeBadges } from "./skill-scope-badges";
import type { SkillDetailState } from "./use-skill-detail";

function resourceIcon(resource: SkillResourceInfo) {
	if (resource.kind === "script") return FileCode2;
	if (resource.kind === "asset") return Image;
	return FileText;
}

function formatResourceBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export interface SkillDetailScrollPosition {
	outer: number;
	navigation: number;
	content: number;
}

interface SkillDetailViewProps {
	detail: SkillDetailState;
	onRetry: () => void;
	onSelectResource: (resource: SkillResourceInfo | null) => void;
	onRetryResource: () => void;
	onError: (cause: unknown) => void;
	scrollPosition?: SkillDetailScrollPosition | undefined;
	onScrollPositionChange?: (position: SkillDetailScrollPosition) => void;
	restoring?: boolean;
}

/** Skill instructions and resources shared by settings dialogs and workspace reading tabs. */
export function SkillDetailView({
	detail,
	onRetry,
	onSelectResource,
	onRetryResource,
	onError,
	scrollPosition,
	onScrollPositionChange,
	restoring = false,
}: SkillDetailViewProps) {
	const hostUiApi = useDomainApi("ui");
	const hostSkillsApi = useDomainApi("skills");

	const { t } = useTranslation();
	const skill = detail.skill;
	const selectedResource = detail.selectedResource;
	const outerRef = useRef<HTMLDivElement>(null);
	const navigationRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLElement>(null);
	const position = useRef<SkillDetailScrollPosition>(
		scrollPosition ? { ...scrollPosition } : { outer: 0, navigation: 0, content: 0 },
	);
	const restored = useRef(scrollPosition === undefined);
	const savePosition = useStableCallback(() => {
		if (restored.current) onScrollPositionChange?.({ ...position.current });
	});
	const contentReady =
		selectedResource === null
			? detail.content !== null
			: detail.resourceContent !== null ||
				selectedResource.contentKind === "binary" ||
				selectedResource.byteLength > SKILL_RESOURCE_CONTENT_MAX_BYTES;
	useLayoutEffect(() => {
		if (restoring || !contentReady || restored.current) return;
		const saved = { ...position.current };
		const outer = outerRef.current;
		const navigation = navigationRef.current;
		const content = contentRef.current;
		if (!outer || !navigation || !content) return;
		// Markdown measures its body asynchronously. Keep the saved position until that body can contain it,
		// and stop restoring as soon as the reader takes control of the scrollport.
		const observer = new ResizeObserver(() => restore());
		const restore = () => {
			if (restored.current) {
				observer.disconnect();
				return;
			}
			const target = { ...saved };
			const scrollports = { outer, navigation, content };
			for (const key of ["outer", "navigation", "content"] as const) {
				const element = scrollports[key];
				// Compact and expanded layouts own different scrollports. An inactive axis cannot restore a saved offset.
				const overflow = getComputedStyle(element).overflowY;
				if (overflow !== "auto" && overflow !== "scroll") target[key] = 0;
				element.scrollTop = target[key];
			}
			if (
				Math.abs(outer.scrollTop - target.outer) < 1 &&
				Math.abs(navigation.scrollTop - target.navigation) < 1 &&
				Math.abs(content.scrollTop - target.content) < 1
			) {
				restored.current = true;
				position.current = target;
				observer.disconnect();
			}
		};
		const takeControl = () => {
			restored.current = true;
			position.current = { outer: outer.scrollTop, navigation: navigation.scrollTop, content: content.scrollTop };
			observer.disconnect();
		};
		for (const element of [outer, navigation, content, content.lastElementChild]) {
			if (element) observer.observe(element);
		}
		outer.addEventListener("wheel", takeControl, { passive: true });
		outer.addEventListener("pointerdown", takeControl);
		outer.addEventListener("keydown", takeControl);
		restore();
		return () => {
			observer.disconnect();
			outer.removeEventListener("wheel", takeControl);
			outer.removeEventListener("pointerdown", takeControl);
			outer.removeEventListener("keydown", takeControl);
		};
	}, [contentReady, restoring]);
	useEffect(() => savePosition, [savePosition]);
	const selectResource = (resource: SkillResourceInfo | null) => {
		restored.current = true;
		position.current.content = 0;
		if (contentRef.current) contentRef.current.scrollTop = 0;
		onSelectResource(resource);
	};
	return (
		<div className="@container/skill flex h-full min-h-0 flex-col">
			<div className="shrink-0 border-b border-border-subtle px-5 py-4 pr-12">
				<div className="flex items-center gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-hover">
						<GraduationCap className="size-4.5 text-text-muted" aria-hidden="true" />
					</div>
					<div className="min-w-0 flex-1">
						<h2 className="truncate font-mono text-base font-semibold text-text-primary">{skill.name}</h2>
						<div className="mt-1 flex flex-wrap items-center gap-1.5">
							<SkillScopeBadges skill={skill} />
							{skill.source !== "auto" && <span className="text-xs text-text-muted">{skill.source}</span>}
						</div>
					</div>
				</div>
			</div>

			<div
				ref={outerRef}
				onScroll={(event) => {
					if (restored.current) position.current.outer = event.currentTarget.scrollTop;
				}}
				className="min-h-0 flex-1 overflow-y-auto @3xl/skill:grid @3xl/skill:grid-cols-[14rem_minmax(0,1fr)] @3xl/skill:overflow-hidden"
			>
				<aside
					ref={navigationRef}
					onScroll={(event) => {
						if (restored.current) position.current.navigation = event.currentTarget.scrollTop;
					}}
					className="flex min-w-0 flex-col gap-5 border-b border-border-subtle p-4 @3xl/skill:overflow-y-auto @3xl/skill:border-r @3xl/skill:border-b-0"
				>
					<section className="flex flex-col gap-1.5">
						<h4 className="text-xs font-medium uppercase tracking-wide text-text-muted">
							{t("skills.detailDescription")}
						</h4>
						<p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{skill.description}</p>
					</section>

					<section className="flex flex-col gap-2">
						<h4 className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("skills.resources")}</h4>
						<button
							type="button"
							aria-current={selectedResource === null ? "page" : undefined}
							onClick={() => selectResource(null)}
							className={cn(
								"flex min-h-8 items-center gap-2 rounded-control px-2 text-left text-xs transition-colors focus-visible:bg-surface-hover",
								selectedResource === null
									? "bg-surface-hover text-text-primary"
									: "text-text-muted hover:bg-surface-hover/60 hover:text-text-primary",
							)}
						>
							<FileText className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="truncate">{t("skills.instructions")}</span>
						</button>
						{detail.resourcesError !== null ? (
							<div className="flex flex-col items-start gap-2">
								<p className="whitespace-pre-wrap text-xs text-danger">{detail.resourcesError}</p>
								<Button variant="outline" size="sm" onClick={onRetry}>
									{t("skills.retry")}
								</Button>
							</div>
						) : detail.resources === null ? (
							<LoadingTransition label={t("skills.resourcesLoading")} size="sm" className="min-h-8 justify-start" />
						) : detail.resources.length === 0 ? (
							<p className="text-xs leading-relaxed text-text-muted">{t("skills.resourcesEmpty")}</p>
						) : (
							<div className="flex flex-col gap-0.5">
								{detail.resources.map((resource) => {
									const Icon = resourceIcon(resource);
									const selected = selectedResource?.relativePath === resource.relativePath;
									return (
										<button
											type="button"
											key={resource.relativePath}
											aria-current={selected ? "page" : undefined}
											onClick={() => selectResource(resource)}
											title={resource.relativePath}
											className={cn(
												"flex min-h-8 min-w-0 items-center gap-2 rounded-control px-2 text-left text-xs transition-colors focus-visible:bg-surface-hover",
												selected
													? "bg-surface-hover text-text-primary"
													: "text-text-muted hover:bg-surface-hover/60 hover:text-text-primary",
											)}
										>
											<Icon className="size-3.5 shrink-0" aria-hidden="true" />
											<span className="min-w-0 flex-1 truncate font-mono text-xs">{resource.relativePath}</span>
											<span className="shrink-0 text-xs tabular-nums text-text-muted">
												{formatResourceBytes(resource.byteLength)}
											</span>
										</button>
									);
								})}
								{detail.resourcesTruncated && (
									<p className="px-2 pt-1 text-xs leading-relaxed text-warning">{t("skills.resourcesTruncated")}</p>
								)}
							</div>
						)}
					</section>

					<section className="flex flex-col gap-2">
						<h4 className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("skills.detailPath")}</h4>
						<code className="break-all rounded-control bg-surface-raised px-2.5 py-2 font-mono text-xs leading-relaxed text-text-muted">
							{tildify(skill.filePath)}
						</code>
						{hostUiApi.capabilities.nativePathReveal && (
							<Button
								variant="outline"
								size="sm"
								className="self-start"
								onClick={() => void hostSkillsApi.reveal({ filePath: skill.filePath }).catch(onError)}
							>
								<ExternalLink className="size-3.5" aria-hidden="true" />
								{t("skills.reveal")}
							</Button>
						)}
					</section>
				</aside>

				<section
					ref={contentRef}
					onScroll={(event) => {
						if (restored.current) position.current.content = event.currentTarget.scrollTop;
					}}
					className="flex min-h-[18rem] min-w-0 flex-col gap-2 p-4 @3xl/skill:min-h-0 @3xl/skill:overflow-y-auto"
				>
					<div className="flex min-h-8 shrink-0 items-center justify-between gap-3">
						<h4 className="min-w-0 truncate text-xs font-medium uppercase tracking-wide text-text-muted">
							{selectedResource?.relativePath ?? t("skills.detailContent")}
						</h4>
						{selectedResource && hostUiApi.capabilities.nativePathReveal && (
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									void hostSkillsApi
										.revealResource({ filePath: skill.filePath, relativePath: selectedResource.relativePath })
										.catch(onError)
								}
							>
								<ExternalLink className="size-3.5" aria-hidden="true" />
								{t("skills.reveal")}
							</Button>
						)}
					</div>
					{selectedResource === null ? (
						detail.contentError !== null ? (
							<FeedbackNotice
								tone="danger"
								title={t("skills.contentLoadFailed")}
								action={<SettingsRetryAction label={t("skills.retry")} onClick={onRetry} />}
							>
								{detail.contentError}
							</FeedbackNotice>
						) : detail.content === null ? (
							<LoadingTransition label={t("skills.detailLoading")} size="sm" className="min-h-12 justify-start px-1" />
						) : (
							<div className="rounded-panel border border-border-subtle bg-surface-raised/40 px-4 py-3 text-sm sm:px-5 sm:py-4">
								<Markdown text={detail.content} />
							</div>
						)
					) : selectedResource.contentKind === "binary" ? (
						<SettingsCollection className="rounded-panel border border-border-subtle bg-surface-raised/40 p-5 text-sm text-text-muted">
							<p className="font-medium text-text-primary">{t("skills.resourceBinary")}</p>
							<p className="mt-1">
								{t("skills.resourceMetadata", { size: formatResourceBytes(selectedResource.byteLength) })}
							</p>
						</SettingsCollection>
					) : selectedResource.byteLength > SKILL_RESOURCE_CONTENT_MAX_BYTES ? (
						<FeedbackNotice tone="warning" title={t("skills.resourceTooLarge")}>
							{t("skills.resourceMetadata", { size: formatResourceBytes(selectedResource.byteLength) })}
						</FeedbackNotice>
					) : detail.resourceContentError !== null ? (
						<FeedbackNotice
							tone="danger"
							title={t("skills.resourceLoadFailed")}
							action={<SettingsRetryAction label={t("skills.retry")} onClick={onRetryResource} />}
						>
							{detail.resourceContentError}
						</FeedbackNotice>
					) : detail.resourceContent === null ? (
						<LoadingTransition label={t("skills.detailLoading")} size="sm" className="min-h-12 justify-start px-1" />
					) : selectedResource.kind === "reference" && selectedResource.relativePath.toLowerCase().endsWith(".md") ? (
						<div className="rounded-panel border border-border-subtle bg-surface-raised/40 px-4 py-3 text-sm sm:px-5 sm:py-4">
							<Markdown text={detail.resourceContent} />
						</div>
					) : (
						<pre className="overflow-auto whitespace-pre-wrap break-words rounded-panel border border-border-subtle bg-surface-raised/40 px-4 py-3 font-mono text-xs leading-relaxed text-text-primary sm:px-5 sm:py-4">
							{detail.resourceContent}
						</pre>
					)}
				</section>
			</div>
		</div>
	);
}

export function SkillDetailDialog({
	detail,
	onClose,
	onRetry,
	onSelectResource,
	onRetryResource,
	onError,
}: {
	detail: SkillDetailState | null;
	onClose: () => void;
	onRetry: () => void;
	onSelectResource: (resource: SkillResourceInfo | null) => void;
	onRetryResource: () => void;
	onError: (cause: unknown) => void;
}) {
	const { t } = useTranslation();
	return (
		<Dialog
			open={detail !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			{detail && (
				<DialogContent size="large" className="h-[min(46rem,calc(100dvh-2rem))] overflow-hidden p-0">
					<DialogTitle className="sr-only">{detail.skill.name}</DialogTitle>
					<SkillDetailView
						detail={detail}
						onRetry={onRetry}
						onSelectResource={onSelectResource}
						onRetryResource={onRetryResource}
						onError={onError}
					/>
					<DialogCloseButton aria-label={t("skills.close")} />
				</DialogContent>
			)}
		</Dialog>
	);
}
