export interface ModelPickerOption {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	reasoning: boolean;
}

export function modelPickerOptionKey(option: Pick<ModelPickerOption, "provider" | "id">): string {
	return JSON.stringify([option.provider, option.id]);
}

function modelPickerSearchText(option: ModelPickerOption): string {
	return [option.name, option.id, option.provider, option.providerName, `${option.provider}/${option.id}`]
		.join("\n")
		.toLocaleLowerCase();
}

export function filterModelPickerOptions(options: readonly ModelPickerOption[], query: string): ModelPickerOption[] {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return [...options];
	return options.filter((option) => modelPickerSearchText(option).includes(normalized));
}
