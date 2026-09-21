import { TextSettingRow } from "@renderer/components/ui/text-setting-row";

interface NumberSettingRowProps {
	label: string;
	description: string;
	value: number;
	min: number;
	max: number;
	onSave(value: number): Promise<boolean>;
}

/** A numeric setting saves on blur or Enter; invalid input stays editable. */
export function NumberSettingRow({ label, description, value, min, max, onSave }: NumberSettingRowProps) {
	return (
		<TextSettingRow
			label={label}
			description={description}
			value={String(value)}
			validate={(draft) =>
				draft.trim().length > 0 && Number.isSafeInteger(Number(draft)) && Number(draft) >= min && Number(draft) <= max
			}
			onSave={(draft) => onSave(Number(draft))}
			input={{ type: "number", min, max, step: "1", className: "w-36 font-mono tabular-nums" }}
		/>
	);
}
