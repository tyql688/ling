import { WorkbenchReadingPane } from "@renderer/components/workbench/workbench-reading-pane";
import { EmptyState } from "@renderer/components/ui/empty-state";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { SkillDetailContent, SkillDetailNavigation } from "./skill-detail-view";
import { useSkillDetail } from "./use-skill-detail";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import type { SkillInfo, SkillResourceInfo } from "@ling/contracts/skill";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { draftsAtom, EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useSetAtom } from "jotai";
import { GraduationCap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SkillBrowser, type SkillBrowserGroup } from "./skill-browser";

export interface ProjectSkillSelection {
	skill: SkillInfo;
	resourcePath: string | null;
	scrollTop: number;
}

/** Effective project skills with a persistent catalog and in-place content selection. */
export function ProjectSkillsPanel({
	session,
	selection,
	onSelectionChange,
	onScrollChange,
}: {
	/** Skill insertion remains bound to the session that owns this workspace panel. */
	session: SessionRef;
	selection: ProjectSkillSelection | null;
	onSelectionChange: (selection: ProjectSkillSelection) => void;
	onScrollChange: (filePath: string, resourcePath: string | null, scrollTop: number) => void;
}) {
	const hostSkillsApi = useDomainApi("skills");
	const { t } = useTranslation();
	const [skills, setSkills] = useState<SkillInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const requestRevisionRef = useRef(0);
	const setDrafts = useSetAtom(draftsAtom);

	const onError = useCommandFeedback();
	const { detail, openDetail, closeDetail, selectResource, retryDetail, retryResource } = useSkillDetail();
	const selectedSkill = selection?.skill ?? null;
	useEffect(() => {
		if (selectedSkill !== null) openDetail(selectedSkill);
		return closeDetail;
	}, [selectedSkill, openDetail, closeDetail]);
	const currentDetail = detail?.skill.filePath === selectedSkill?.filePath ? detail : null;
	const chooseResource = (resource: SkillResourceInfo | null) => {
		if (currentDetail)
			onSelectionChange({ skill: currentDetail.skill, resourcePath: resource?.relativePath ?? null, scrollTop: 0 });
	};
	const resourcePath = selection?.resourcePath ?? null;
	const resource = currentDetail?.resources?.find((item) => item.relativePath === resourcePath) ?? null;
	const missingResource = resourcePath !== null && currentDetail?.resources != null && resource === null;
	useEffect(() => {
		if (currentDetail !== null && currentDetail.resources !== null && currentDetail.selectedResource !== resource) {
			selectResource(resource);
		}
	}, [currentDetail, resource, selectResource]);
	const loadingResource =
		currentDetail !== null &&
		((resourcePath !== null && currentDetail.resources === null && currentDetail.resourcesError === null) ||
			currentDetail.selectedResource !== resource);

	const useSkill = useCallback(
		(skill: SkillInfo) => {
			const key = sessionKey(session);
			setDrafts((drafts) => {
				const draft = drafts[key] ?? EMPTY_DRAFT;
				return { ...drafts, [key]: { ...draft, text: `/skill:${skill.name} ${draft.text}` } };
			});
		},
		[session, setDrafts],
	);

	const load = useCallback(() => {
		requestRevisionRef.current += 1;
		const revision = requestRevisionRef.current;
		setSkills(null);
		setError(null);
		void hostSkillsApi
			.projectSkills({ cwd: session.cwd })
			.then((loaded) => {
				if (revision === requestRevisionRef.current) setSkills(loaded);
			})
			.catch((cause: unknown) => {
				if (revision === requestRevisionRef.current) setError(formatRequestError(cause));
			});
	}, [hostSkillsApi, session.cwd]);

	useEffect(() => {
		load();
		return () => {
			requestRevisionRef.current += 1;
		};
	}, [load]);

	const groups = useMemo<SkillBrowserGroup[]>(
		() =>
			skills === null
				? []
				: [
						{
							key: "project",
							title: t("skills.sectionProject"),
							skills: skills.filter((skill) => skill.scope === "project"),
						},
						{
							key: "global",
							title: t("skills.sectionGlobal"),
							skills: skills.filter((skill) => skill.scope !== "project" && skill.origin !== "package"),
						},
						{
							key: "packages",
							title: t("skills.sectionPackages"),
							skills: skills.filter((skill) => skill.scope !== "project" && skill.origin === "package"),
						},
					],
		[skills, t],
	);

	const catalog = (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
			{skills === null &&
				(error === null ? (
					<LoadingTransition label={t("skills.loading")} className="min-h-28" />
				) : (
					<SettingsState
						icon={GraduationCap}
						title={t("skills.loadFailed")}
						description={error}
						tone="danger"
						action={<SettingsRetryAction label={t("skills.retry")} onClick={load} />}
						compact
					/>
				))}
			{skills !== null && skills.length === 0 && (
				<SettingsState
					icon={GraduationCap}
					title={t("skills.emptyProjectTitle")}
					description={t("skills.emptyProject")}
					compact
				/>
			)}
			{skills !== null && skills.length > 0 && (
				<SkillBrowser
					tree
					groups={groups}
					onSelect={(skill) => {
						if (skill.filePath !== selection?.skill.filePath)
							onSelectionChange({ skill, resourcePath: null, scrollTop: 0 });
					}}
					selectedPath={selection?.skill.filePath}
					onUse={useSkill}
					contained
					className="min-h-0 flex-1"
				/>
			)}
		</div>
	);

	return (
		<WorkbenchReadingPane
			navigationLabel={t("skills.title")}
			selectionKey={`${selectedSkill?.filePath ?? ""}:${resourcePath ?? ""}`}
			navigation={
				<div className="flex min-h-0 flex-1 flex-col">
					{catalog}
					{currentDetail && (
						<div className="flex max-h-[45%] shrink-0 flex-col overflow-y-auto border-t border-border-subtle">
							<SkillDetailNavigation
								detail={currentDetail}
								onRetry={retryDetail}
								onError={onError}
								onSelectResource={chooseResource}
							/>
						</div>
					)}
				</div>
			}
		>
			{selectedSkill === null ? (
				<EmptyState title={t("skills.selectToRead")} className="flex-1" />
			) : currentDetail === null || loadingResource ? (
				<LoadingTransition label={t("skills.detailLoading")} className="flex-1" />
			) : resourcePath !== null && currentDetail.resourcesError !== null ? (
				<FeedbackNotice tone="danger" action={<SettingsRetryAction label={t("skills.retry")} onClick={retryDetail} />}>
					{currentDetail.resourcesError}
				</FeedbackNotice>
			) : (
				<>
					{missingResource && (
						<FeedbackNotice tone="warning">{t("skills.resourceUnavailable", { path: resourcePath })}</FeedbackNotice>
					)}
					<SkillDetailContent
						key={`${selectedSkill.filePath}:${resourcePath ?? ""}`}
						detail={currentDetail}
						onRetry={retryDetail}
						onRetryResource={retryResource}
						onError={onError}
						onSelectResource={chooseResource}
						scrollTop={selection?.scrollTop ?? 0}
						onScrollChange={(top) => onScrollChange(selectedSkill.filePath, resourcePath, top)}
					/>
				</>
			)}
		</WorkbenchReadingPane>
	);
}
