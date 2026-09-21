import type { SkillInfo } from "@ling/contracts/skill";
import { Badge } from "@renderer/components/ui/badge";
import { basenameFromPath } from "@renderer/lib/format-path";
import { useTranslation } from "react-i18next";

export function SkillScopeBadges({ skill }: { skill: SkillInfo }) {
	const { t } = useTranslation();
	const scopeLabel = skill.builtin
		? t("skills.scopeBuiltin")
		: skill.origin === "package"
			? t("skills.scopePackage")
			: skill.scope === "project"
				? skill.projectCwd === null
					? t("skills.scopeProject")
					: basenameFromPath(skill.projectCwd)
				: t("skills.scopeGlobal");
	return (
		<>
			<Badge>{scopeLabel}</Badge>
			{skill.disableModelInvocation && <Badge variant="accent">{t("skills.manualOnly")}</Badge>}
		</>
	);
}
