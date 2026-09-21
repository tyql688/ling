import type { SkillInfo } from "@ling/contracts/skill";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useEffect, useRef, useState } from "react";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useTranslation } from "react-i18next";
import { SkillDetailView, type SkillDetailScrollPosition } from "./skill-detail-view";
import { useSkillDetail } from "./use-skill-detail";

export interface SkillReadingState {
	selectedResourcePath: string | null;
	position?: SkillDetailScrollPosition;
}

/** Non-modal skill details opened from the workspace directory into a normal reading tab. */
export function SkillReadingView({
	skill,
	view,
	onViewChange,
}: {
	skill: SkillInfo;
	view?: SkillReadingState | undefined;
	onViewChange: (view: SkillReadingState) => void;
}) {
	const { t } = useTranslation();
	const onError = useCommandFeedback();
	const { detail, openDetail, selectResource, retryDetail, retryResource, closeDetail } = useSkillDetail();
	const initialResourcePath = useRef(view?.selectedResourcePath ?? null);
	const [restoring, setRestoring] = useState(initialResourcePath.current !== null);
	const [missingResource, setMissingResource] = useState<string | null>(null);
	useEffect(() => {
		openDetail(skill);
		return closeDetail;
	}, [closeDetail, openDetail, skill]);
	useEffect(() => {
		if (!restoring || detail?.resources == null) return;
		const path = initialResourcePath.current;
		const resource = detail.resources.find((item) => item.relativePath === path);
		if (resource) selectResource(resource);
		else setMissingResource(path);
		setRestoring(false);
	}, [detail?.resources, restoring, selectResource]);

	if (detail === null || detail.skill.filePath !== skill.filePath) {
		return <LoadingTransition label={t("skills.detailLoading")} className="h-full min-h-40" />;
	}
	return (
		<>
			{missingResource !== null && (
				<FeedbackNotice tone="warning">{t("skills.resourceUnavailable", { path: missingResource })}</FeedbackNotice>
			)}
			<SkillDetailView
				detail={detail}
				scrollPosition={view?.position}
				restoring={restoring}
				onScrollPositionChange={(position) =>
					onViewChange({ selectedResourcePath: detail.selectedResource?.relativePath ?? null, position })
				}
				onRetry={retryDetail}
				onSelectResource={(resource) => {
					setRestoring(false);
					setMissingResource(null);
					selectResource(resource);
					onViewChange({ selectedResourcePath: resource?.relativePath ?? null });
				}}
				onRetryResource={retryResource}
				onError={onError}
			/>
		</>
	);
}
