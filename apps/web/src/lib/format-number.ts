/** Compact counts follow the selected language, including 万, 億, 만 and 억. */
export function formatCompactNumber(value: number, language: string): string {
	return new Intl.NumberFormat(language, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}
