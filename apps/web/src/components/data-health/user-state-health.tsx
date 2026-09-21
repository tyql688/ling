import { useDataIssue } from "@renderer/lib/data-health/state";
import { retryUserStateAtom, userStateStatusAtom } from "@renderer/lib/user-state/state";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";

export function UserStateHealth() {
	const status = useAtomValue(userStateStatusAtom),
		retry = useAtomValue(retryUserStateAtom),
		{ t } = useTranslation();
	useDataIssue(
		"ling/user-state",
		status.error || status.issues.length > 0
			? {
					label: t("data.userState"),
					message: [status.error, ...status.issues.map((issue) => `${issue.key}: ${issue.message}`)]
						.filter(Boolean)
						.join("\n"),
					...(retry ? { retry } : {}),
				}
			: null,
	);
	return null;
}
