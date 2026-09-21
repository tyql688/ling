import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Ling's UI text scale must remain independent of text color overrides.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["ui"] } } });

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
