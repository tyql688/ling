export interface ActiveSessionRuntimeIdentity {
	refKey: string;
	runtimeId: string;
	generation: number;
}

export interface SessionRuntimeIdentity {
	refKey: string;
	runtimeId: string | null;
	generation: number;
}

interface ActiveSessionRuntimeInput {
	identity: ActiveSessionRuntimeIdentity;
	inputRevision: number;
	text: string;
	cursorOffset: number;
}

interface CurrentSessionRuntimeInput {
	identity: SessionRuntimeIdentity;
	inputRevision: number;
	text: string;
	cursorOffset: number;
}

export interface SessionRuntimeInputBoundValue<Value> extends ActiveSessionRuntimeInput {
	value: Value;
}

export function bindSessionRuntimeInputValue<Value>(
	input: ActiveSessionRuntimeInput,
	value: Value,
): SessionRuntimeInputBoundValue<Value> {
	return { ...input, value };
}

/** Autocomplete output is usable only for the exact runtime and composer
 * snapshot that requested it. This render-time check closes the interval
 * before a changed-input effect has invalidated the previous request. */
export function currentSessionRuntimeInputBoundValue<Value>(
	bound: SessionRuntimeInputBoundValue<Value> | null,
	current: CurrentSessionRuntimeInput,
): SessionRuntimeInputBoundValue<Value> | null {
	if (
		!bound ||
		current.identity.runtimeId === null ||
		bound.identity.refKey !== current.identity.refKey ||
		bound.identity.runtimeId !== current.identity.runtimeId ||
		bound.identity.generation !== current.identity.generation ||
		bound.inputRevision !== current.inputRevision ||
		bound.text !== current.text ||
		bound.cursorOffset !== current.cursorOffset
	) {
		return null;
	}
	return bound;
}
