type ChangeReviewPane = "files" | "detail";

interface ChangeReviewNavigationState {
	selectedPath: string | null;
	pane: ChangeReviewPane;
}

type ChangeReviewNavigationAction =
	| { type: "ensureSelection"; paths: readonly string[] }
	| { type: "selectFile"; path: string }
	| { type: "showFiles" }
	| { type: "resetScope" };

/** Initial review-navigation state: no file selected, staying on the file-list pane. */
export const INITIAL_CHANGE_REVIEW_NAVIGATION: ChangeReviewNavigationState = {
	selectedPath: null,
	pane: "files",
};

export function changeReviewNavigationReducer(
	state: ChangeReviewNavigationState,
	action: ChangeReviewNavigationAction,
): ChangeReviewNavigationState {
	switch (action.type) {
		case "ensureSelection": {
			if (state.selectedPath !== null && action.paths.includes(state.selectedPath)) return state;
			const selectedPath = action.paths[0] ?? null;
			return {
				selectedPath,
				pane: selectedPath === null ? "files" : state.pane,
			};
		}
		case "selectFile":
			return { selectedPath: action.path, pane: "detail" };
		case "showFiles":
			return state.pane === "files" ? state : { ...state, pane: "files" };
		case "resetScope":
			return INITIAL_CHANGE_REVIEW_NAVIGATION;
	}
}
