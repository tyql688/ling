import type { ThinkingLevel } from "@ling/contracts/session";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Shared picker for the session's resolved thinking level. */
export function ThinkingLevelSelect({
	value,
	levels,
	onChange,
	triggerClassName,
	icon,
	disabled,
}: {
	value: ThinkingLevel;
	levels: readonly ThinkingLevel[];
	onChange: (level: ThinkingLevel) => void;
	triggerClassName?: string;
	icon?: ReactNode;
	disabled?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (next) onChange(next as ThinkingLevel);
			}}
			{...(disabled === undefined ? {} : { disabled })}
		>
			<SelectTrigger aria-label={t("session.thinkingLevelLabel")} className={triggerClassName}>
				{icon}
				<SelectValue>{() => t(`session.thinkingLevel_${value}`)}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{levels.map((level) => (
					<SelectItem key={level} value={level}>
						{t(`session.thinkingLevel_${level}`)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
