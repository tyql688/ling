import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import type { SkillInfo } from "@ling/contracts/skill";
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

/** Effective project skills rendered as a persistent directory browser in the workspace sidebar. */
export function ProjectSkillsPanel({
	session,
	onOpenSkill,
}: {
	/** Skill insertion remains bound to the session that owns this workspace panel. */
	session: SessionRef;
	onOpenSkill: (skill: SkillInfo) => void;
}) {
	const hostSkillsApi = useDomainApi("skills");
	const { t } = useTranslation();
	const [skills, setSkills] = useState<SkillInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const requestRevisionRef = useRef(0);
	const setDrafts = useSetAtom(draftsAtom);

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

	return (
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
				<SkillBrowser groups={groups} onSelect={onOpenSkill} onUse={useSkill} contained className="min-h-0 flex-1" />
			)}
		</div>
	);
}
