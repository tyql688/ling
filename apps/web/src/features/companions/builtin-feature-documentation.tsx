import type { BuiltinFeatureId } from "@ling/contracts/builtin-features";
import { Button } from "@renderer/components/ui/button";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { formatRequestError } from "@renderer/lib/errors";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

const documentation: Record<BuiltinFeatureId, string> = {
	todo: "https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo#readme",
	permissions: "https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system#readme",
	questions: "https://github.com/tyql688/ling/blob/main/docs/design.md#questions-and-approvals",
	"background-tasks":
		"https://github.com/tyql688/ling/blob/main/docs/architecture.md#built-in-features-and-pi-adapters",
	schedules: "https://github.com/tyql688/ling/blob/main/docs/architecture.md#built-in-features-and-pi-adapters",
	voice: "https://github.com/earendil-works/pi-voice#readme",
	mcp: "https://github.com/nicobailon/pi-mcp-adapter#readme",
};

export function BuiltinFeatureDocumentation({
	id,
	label,
	compact = false,
}: {
	id: BuiltinFeatureId;
	label: string;
	compact?: boolean;
}) {
	const { t } = useTranslation();
	const app = useDomainApi("app");
	const feedback = useAppFeedback();
	const accessibleLabel = t("builtinFeatures.openDocumentation", { feature: label });
	const open = () => {
		void app.openExternal(documentation[id]).catch((error: unknown) => {
			feedback.show({
				tone: "danger",
				title: t("builtinFeatures.documentationFailed"),
				description: formatRequestError(error, t),
				dedupeKey: `builtin-documentation:${id}`,
			});
		});
	};
	if (compact) {
		return (
			<TooltipIconButton label={accessibleLabel} title={documentation[id]} onClick={open}>
				<ExternalLink className="size-3.5" aria-hidden="true" />
			</TooltipIconButton>
		);
	}
	return (
		<Button variant="ghost" size="sm" aria-label={accessibleLabel} title={documentation[id]} onClick={open}>
			<ExternalLink className="size-3.5" aria-hidden="true" />
			{t("builtinFeatures.documentation")}
		</Button>
	);
}
