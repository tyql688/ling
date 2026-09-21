interface CustomPanelFocusTarget {
	readonly isConnected: boolean;
	focus(): void;
}

interface CustomPanelFocusElement extends CustomPanelFocusTarget {
	contains(target: unknown): boolean;
}

interface CustomPanelFocusState {
	readonly restoreTarget: CustomPanelFocusTarget | null;
	readonly ownsFocus: boolean;
}

/** Empty custom-panel focus state: focus not owned, no restore target. */
export const EMPTY_CUSTOM_PANEL_FOCUS_STATE: CustomPanelFocusState = {
	restoreTarget: null,
	ownsFocus: false,
};

function isFocusTarget(value: unknown): value is CustomPanelFocusTarget {
	if (typeof value !== "object" || value === null) return false;
	return "isConnected" in value && "focus" in value && typeof value.focus === "function";
}

export function isPassiveCustomPanel(nonCapturing: boolean, focused: boolean): boolean {
	return nonCapturing && !focused;
}

export function synchronizeCustomPanelFocus(
	state: CustomPanelFocusState,
	panel: CustomPanelFocusElement | null,
	activeElement: unknown,
	shouldFocus: boolean,
): CustomPanelFocusState {
	if (shouldFocus && panel !== null) {
		const panelContainsFocus = panel.contains(activeElement);
		const restoreTarget =
			!state.ownsFocus && !panelContainsFocus && isFocusTarget(activeElement) ? activeElement : state.restoreTarget;
		if (!panelContainsFocus) panel.focus();
		return { restoreTarget, ownsFocus: true };
	}

	if (!state.ownsFocus) return state;
	if (state.restoreTarget?.isConnected) state.restoreTarget.focus();
	return EMPTY_CUSTOM_PANEL_FOCUS_STATE;
}
