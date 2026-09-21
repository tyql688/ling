import { terminalFontFamilyAtom, terminalFontSizeAtom } from "@renderer/features/terminal/terminal-preferences";
import { pendingUserMutationsAtom, retryUserStateAtom } from "@renderer/lib/user-state/state";
import { useAtom, useStore } from "jotai";
import { useTranslation } from "react-i18next";
import { NumberSettingRow } from "@renderer/components/ui/number-setting-row";
import { TextSettingRow } from "@renderer/components/ui/text-setting-row";

export function TerminalTypographySettings() {
	const { t } = useTranslation();
	const [family, setFamily] = useAtom(terminalFontFamilyAtom);
	const [size, setSize] = useAtom(terminalFontSizeAtom);
	const store = useStore();
	async function acknowledge(key: "terminalFontFamily" | "terminalFontSize") {
		const synchronize = store.get(retryUserStateAtom);
		if (!synchronize) return false;
		await synchronize();
		return !store
			.get(pendingUserMutationsAtom)
			.some((entry) => entry.mutation.type === "preference" && entry.mutation.preference.key === key);
	}
	return (
		<>
			<TextSettingRow
				label={t("settings.terminalFontFamily")}
				description={t("settings.terminalFontFamilyDescription")}
				value={family}
				placeholder="JetBrains Mono"
				onSave={async (value) => {
					if (value.length > 200) return false;
					setFamily(value);
					return (await acknowledge("terminalFontFamily")) && store.get(terminalFontFamilyAtom) === value;
				}}
			/>
			<NumberSettingRow
				label={t("settings.terminalFontSize")}
				description={t("settings.terminalFontSizeDescription")}
				value={size}
				min={12}
				max={22}
				onSave={async (value) => {
					setSize(value);
					return (await acknowledge("terminalFontSize")) && store.get(terminalFontSizeAtom) === value;
				}}
			/>
		</>
	);
}
