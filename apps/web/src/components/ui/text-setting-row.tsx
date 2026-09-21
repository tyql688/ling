import { Input } from "@renderer/components/ui/input";
import { SettingsFieldRow } from "@renderer/components/ui/settings-list";
import { SettingSaveStatus } from "@renderer/components/ui/setting-save-status";
import { useSettingDraft } from "@renderer/hooks/use-setting-draft";
import type { ComponentProps } from "react";

/** A text setting saves on blur or Enter; Escape restores the saved value. */
export function TextSettingRow({
	label,
	description,
	value,
	placeholder,
	disabled = false,
	validate,
	onSave,
	input = { className: "w-56 font-mono" },
}: {
	label: string;
	description: string;
	value: string;
	placeholder?: string;
	disabled?: boolean;
	validate?: (value: string) => boolean;
	onSave(value: string): Promise<boolean>;
	input?: Pick<ComponentProps<typeof Input>, "type" | "min" | "max" | "step" | "className">;
}) {
	const field = useSettingDraft(value, onSave, validate);
	return (
		<SettingsFieldRow label={label} description={description}>
			{({ controlId, labelId, descriptionId }) => (
				<>
					<SettingSaveStatus state={field.state} retry={() => void field.commit()} />
					<Input
						{...input}
						id={controlId}
						aria-labelledby={labelId}
						aria-describedby={descriptionId}
						value={field.draft}
						placeholder={placeholder}
						disabled={disabled || field.state.status === "saving"}
						aria-invalid={!field.valid}
						onChange={(event) => field.change(event.target.value)}
						onBlur={() => void field.commit()}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "Enter") {
								event.preventDefault();
								void field.commit();
							} else if (event.key === "Escape") {
								event.stopPropagation();
								field.reset();
							}
						}}
					/>
				</>
			)}
		</SettingsFieldRow>
	);
}
