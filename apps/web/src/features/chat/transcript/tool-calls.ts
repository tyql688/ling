interface ToolCallLike {
	type: "toolCall";
	id: string;
}

export function uniqueToolCalls<T extends ToolCallLike>(parts: readonly T[]): T[] {
	const unique: T[] = [];
	const indexById = new Map<string, number>();
	for (const part of parts) {
		const existing = indexById.get(part.id);
		if (existing === undefined) {
			indexById.set(part.id, unique.length);
			unique.push(part);
			continue;
		}
		unique[existing] = part;
	}
	return unique;
}
