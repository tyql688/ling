import { useDomainApi } from "@renderer/lib/host-api-context";
import { SKILL_RESOURCE_CONTENT_MAX_BYTES, type SkillInfo, type SkillResourceInfo } from "@ling/contracts/skill";
import { formatRequestError } from "@renderer/lib/errors";
import { useCallback, useRef, useState } from "react";

export interface SkillDetailState {
	skill: SkillInfo;
	content: string | null;
	contentError: string | null;
	resources: SkillResourceInfo[] | null;
	resourcesTruncated: boolean;
	resourcesError: string | null;
	selectedResource: SkillResourceInfo | null;
	resourceContent: string | null;
	resourceContentError: string | null;
}

/** Shared skill-detail state: opening a skill lazily loads its body and bounded resource inventory. */
export function useSkillDetail() {
	const hostSkillsApi = useDomainApi("skills");

	const [detail, setDetail] = useState<SkillDetailState | null>(null);
	const requestRevisionRef = useRef(0);
	const resourceRevisionRef = useRef(0);
	const skillPathRef = useRef<string | null>(null);
	const loadDetail = useCallback(
		(skill: SkillInfo) => {
			skillPathRef.current = skill.filePath;
			requestRevisionRef.current += 1;
			resourceRevisionRef.current += 1;
			const revision = requestRevisionRef.current;
			setDetail({
				skill,
				content: null,
				contentError: null,
				resources: null,
				resourcesTruncated: false,
				resourcesError: null,
				selectedResource: null,
				resourceContent: null,
				resourceContentError: null,
			});
			void hostSkillsApi
				.readContent({ filePath: skill.filePath })
				.then((content) =>
					setDetail((current) =>
						revision === requestRevisionRef.current && current?.skill.filePath === skill.filePath
							? { ...current, content, contentError: null }
							: current,
					),
				)
				.catch((cause: unknown) =>
					setDetail((current) =>
						revision === requestRevisionRef.current && current?.skill.filePath === skill.filePath
							? { ...current, contentError: formatRequestError(cause) }
							: current,
					),
				);
			void hostSkillsApi
				.listResources({ filePath: skill.filePath })
				.then((snapshot) =>
					setDetail((current) =>
						revision === requestRevisionRef.current && current?.skill.filePath === skill.filePath
							? {
									...current,
									resources: snapshot.resources,
									resourcesTruncated: snapshot.truncated,
									resourcesError: null,
								}
							: current,
					),
				)
				.catch((cause: unknown) =>
					setDetail((current) =>
						revision === requestRevisionRef.current && current?.skill.filePath === skill.filePath
							? { ...current, resourcesError: formatRequestError(cause) }
							: current,
					),
				);
		},
		[hostSkillsApi],
	);
	const selectResource = useCallback(
		(resource: SkillResourceInfo | null) => {
			resourceRevisionRef.current += 1;
			const revision = resourceRevisionRef.current;
			setDetail((current) =>
				current
					? { ...current, selectedResource: resource, resourceContent: null, resourceContentError: null }
					: current,
			);
			if (
				resource === null ||
				resource.contentKind === "binary" ||
				resource.byteLength > SKILL_RESOURCE_CONTENT_MAX_BYTES
			) {
				return;
			}
			const filePath = skillPathRef.current;
			if (filePath === null) return;
			void hostSkillsApi
				.readResource({ filePath, relativePath: resource.relativePath })
				.then((content) =>
					setDetail((latest) =>
						revision === resourceRevisionRef.current && latest?.skill.filePath === filePath
							? { ...latest, resourceContent: content, resourceContentError: null }
							: latest,
					),
				)
				.catch((cause: unknown) =>
					setDetail((latest) =>
						revision === resourceRevisionRef.current && latest?.skill.filePath === filePath
							? { ...latest, resourceContentError: formatRequestError(cause) }
							: latest,
					),
				);
		},
		[hostSkillsApi],
	);
	const retryDetail = () => {
		if (detail !== null) loadDetail(detail.skill);
	};
	const retryResource = () => {
		if (detail?.selectedResource) selectResource(detail.selectedResource);
	};
	const closeDetail = useCallback(() => {
		requestRevisionRef.current += 1;
		resourceRevisionRef.current += 1;
		skillPathRef.current = null;
		setDetail(null);
	}, []);
	return { detail, openDetail: loadDetail, selectResource, retryDetail, retryResource, closeDetail };
}
