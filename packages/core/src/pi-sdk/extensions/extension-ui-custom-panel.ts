import { type ExtensionUiBridge, createUnsupportedExtensionUiError } from "../../pi-protocol/extension-ui";
import {
	type PiExtensionComponents,
	disposePiWidgetComponent,
	type PiInteractiveComponent,
	setPiInteractiveComponentFocus,
} from "./extension-ui-components";
import type { PiExtensionTerminalInput } from "./extension-ui-terminal-input";
import type { ExtensionUiViewports, ExtensionUiViewport } from "./extension-ui-viewport";
import type { ExtensionCustomPanelLayout, ExtensionTerminalInputResult } from "@ling/contracts/session-extension-ui";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { attemptCleanup, throwAggregateFailures } from "@ling/core/ling-error";
import { createLogger } from "../../logger";
import type { PiTheme } from "../types";
import { createLingKeybindings } from "./extension-ui-keybindings";
import { createOffscreenWidgetTui } from "./extension-ui-offscreen-tui";
import {
	EXTENSION_UI_RENDER_ROWS,
	EXTENSION_UI_RENDER_WIDTH,
	normalizeCustomOverlayLayout,
	type PiCustomOptions,
} from "./extension-ui-overlay-layout";
import { assertPiRenderedLines, isPiWidgetComponent } from "./extension-ui-renderable";

const log = createLogger("pi-extension-ui-custom-panel");

export type PiCustomFactory<T> = (
	tui: unknown,
	theme: PiTheme,
	keybindings: unknown,
	done: (result: T) => void,
) => unknown;

interface ActiveCustomPanel {
	registration: CustomPanelRegistration;
	component: PiInteractiveComponent;
	layout: ExtensionCustomPanelLayout;
	renderWidth: number;
	renderRows: number;
	visible: boolean;
	resolveLayout(): { layout: ExtensionCustomPanelLayout; renderWidth: number; renderRows: number; visible: boolean };
	setTerminalGeometry(columns: number, rows: number): void;
	closed: boolean;
	hidden: boolean;
	focused: boolean;
}

interface CustomPanelRegistration {
	generation: number;
	closed: boolean;
	resolve: ((result: unknown) => void) | null;
	reject: ((error: unknown) => void) | null;
	pendingFactory: PendingCustomPanelFactory | null;
}

interface PendingCustomPanelFactory {
	complete(created: unknown): void;
	fail(error: unknown): void;
}

function assertInteractiveComponent(value: unknown, capability: string): asserts value is PiInteractiveComponent {
	if (!isPiWidgetComponent(value)) throw createUnsupportedExtensionUiError(`${capability}(component)`);
}

function assertRenderedLines(value: unknown, capability: string): asserts value is string[] {
	assertPiRenderedLines(value, () => createUnsupportedExtensionUiError(`${capability}.render`));
}

function disposeAbandonedFactoryValue(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	try {
		const dispose = Reflect.get(value, "dispose");
		if (typeof dispose === "function") Reflect.apply(dispose, value, []);
	} catch (error) {
		log.error("abandoned extension custom panel dispose failed:", error);
	}
}

function completeCustomPanelFactory(registration: CustomPanelRegistration, created: unknown): void {
	const pending = registration.pendingFactory;
	registration.pendingFactory = null;
	if (pending === null) {
		disposeAbandonedFactoryValue(created);
		return;
	}
	pending.complete(created);
}

function failCustomPanelFactory(registration: CustomPanelRegistration, error: unknown): void {
	const pending = registration.pendingFactory;
	registration.pendingFactory = null;
	pending?.fail(error);
}

export function createPiExtensionCustomPanels({
	bridge,
	components,
	terminalInput,
	viewports,
}: {
	bridge: ExtensionUiBridge;
	components: PiExtensionComponents;
	terminalInput: PiExtensionTerminalInput;
	viewports: ExtensionUiViewports;
}) {
	const { emitExtensionUiState } = bridge;
	const { getPiExtensionThemeProxy } = components;
	const { dispatchPiExtensionTerminalInput } = terminalInput;
	const { forgetExtensionUiViewport, getExtensionUiViewport, storeExtensionUiViewport } = viewports;

	const customPanelsBySession = new Map<string, ActiveCustomPanel>();
	const customPanelRegistrationsBySession = new Map<string, CustomPanelRegistration>();
	let nextCustomPanelGeneration = 0;

	function ownsRegistration(ref: SessionRef, registration: CustomPanelRegistration): boolean {
		return !registration.closed && customPanelRegistrationsBySession.get(sessionKey(ref)) === registration;
	}

	function getOwnedPanel(ref: SessionRef, registration: CustomPanelRegistration): ActiveCustomPanel | undefined {
		const panel = customPanelsBySession.get(sessionKey(ref));
		return panel?.registration === registration &&
			panel.registration.generation === registration.generation &&
			!panel.closed
			? panel
			: undefined;
	}

	function closeOwnedPanel(
		ref: SessionRef,
		registration: CustomPanelRegistration,
		result: unknown,
		reject = false,
	): void {
		const key = sessionKey(ref);
		if (!ownsRegistration(ref, registration)) return;
		registration.closed = true;
		customPanelRegistrationsBySession.delete(key);
		registration.pendingFactory = null;
		const settle = reject ? registration.reject : registration.resolve;
		registration.resolve = null;
		registration.reject = null;

		const panel = customPanelsBySession.get(key);
		const failures: unknown[] = [];
		if (panel?.registration === registration) {
			panel.closed = true;
			customPanelsBySession.delete(key);
			attemptCleanup(failures, () =>
				emitExtensionUiState(ref, { type: "custom", lines: null, hidden: false, focused: false, layout: null }),
			);
			attemptCleanup(failures, () => setPiInteractiveComponentFocus(panel.component, false));
			disposePiWidgetComponent("extension custom panel", panel.component, failures);
		}

		attemptCleanup(failures, () => {
			settle?.(result);
		});
		throwAggregateFailures(failures, "Failed to close the Pi extension custom panel");
	}

	function closePanel(ref: SessionRef, result: unknown, reject = false): void {
		const registration = customPanelRegistrationsBySession.get(sessionKey(ref));
		if (!registration) return;
		closeOwnedPanel(ref, registration, result, reject);
	}

	function renderCustomPanel(ref: SessionRef, panel: ActiveCustomPanel, hidden = false): void {
		if (getOwnedPanel(ref, panel.registration) !== panel) return;
		const resolved = panel.resolveLayout();
		if (getOwnedPanel(ref, panel.registration) !== panel) return;
		const { layout, renderWidth, renderRows, visible } = resolved;
		const visualHidden = hidden || !visible;
		const focused = !visualHidden && panel.focused;
		panel.layout = layout;
		panel.renderWidth = renderWidth;
		panel.renderRows = renderRows;
		panel.visible = visible;
		const viewport = getExtensionUiViewport(ref);
		panel.setTerminalGeometry(
			viewport === undefined ? EXTENSION_UI_RENDER_WIDTH : viewport.columns,
			viewport === undefined ? EXTENSION_UI_RENDER_ROWS : viewport.rows,
		);
		setPiInteractiveComponentFocus(panel.component, focused);
		if (getOwnedPanel(ref, panel.registration) !== panel) return;
		const lines = visualHidden ? [] : panel.component.render(renderWidth);
		assertRenderedLines(lines, "custom(component)");
		if (getOwnedPanel(ref, panel.registration) !== panel) return;
		emitExtensionUiState(ref, {
			type: "custom",
			lines,
			hidden: visualHidden,
			focused,
			layout,
		});
	}

	function sendPiExtensionUiInput(ref: SessionRef, data: string): ExtensionTerminalInputResult {
		const routed = dispatchPiExtensionTerminalInput(ref, data);
		if (routed.consumed) return routed;
		const panel = customPanelsBySession.get(sessionKey(ref));
		if (!panel || panel.closed) return routed;
		try {
			panel.component.handleInput?.(routed.data);
			if (panel.closed) return { consumed: true, data: routed.data };
			renderCustomPanel(ref, panel, panel.hidden);
			return { consumed: true, data: routed.data };
		} catch (error) {
			closeOwnedPanel(ref, panel.registration, error, true);
			throw error;
		}
	}

	function updatePiExtensionUiViewport(
		ref: SessionRef,
		viewport: ExtensionUiViewport,
	): { markdownColumns: boolean; dockColumns: boolean } {
		const measurements = [viewport.columns, viewport.rows, viewport.markdownColumns, viewport.dockColumns];
		if (measurements.some((value) => !Number.isInteger(value) || value <= 0)) {
			throw new Error("Invalid extension UI viewport");
		}
		const previous = getExtensionUiViewport(ref);
		storeExtensionUiViewport(ref, viewport);
		const changed = {
			markdownColumns: previous?.markdownColumns !== viewport.markdownColumns,
			dockColumns: previous?.dockColumns !== viewport.dockColumns,
		};
		const panel = customPanelsBySession.get(sessionKey(ref));
		if (!panel || panel.closed) return changed;
		try {
			renderCustomPanel(ref, panel, panel.hidden);
		} catch (error) {
			closeOwnedPanel(ref, panel.registration, error, true);
			throw error;
		}
		return changed;
	}

	function createOverlayHandle(ref: SessionRef, registration: CustomPanelRegistration): unknown {
		return {
			hide() {
				const panel = getOwnedPanel(ref, registration);
				if (!panel) return;
				panel.hidden = true;
				panel.focused = false;
				setPiInteractiveComponentFocus(panel.component, false);
				emitExtensionUiState(ref, { type: "customVisibility", hidden: true, focused: false });
			},
			setHidden(hidden: boolean) {
				const panel = getOwnedPanel(ref, registration);
				if (!panel) return;
				panel.hidden = hidden;
				if (hidden) panel.focused = false;
				else if (!panel.layout.nonCapturing) panel.focused = true;
				setPiInteractiveComponentFocus(panel.component, !panel.hidden && panel.focused);
				if (hidden) emitExtensionUiState(ref, { type: "customVisibility", hidden, focused: panel.focused });
				else renderCustomPanel(ref, panel, false);
			},
			isHidden() {
				const panel = getOwnedPanel(ref, registration);
				return panel === undefined ? true : panel.hidden;
			},
			focus() {
				const panel = getOwnedPanel(ref, registration);
				if (!panel) return;
				panel.hidden = false;
				panel.focused = true;
				setPiInteractiveComponentFocus(panel.component, true);
				renderCustomPanel(ref, panel, false);
			},
			unfocus() {
				const panel = getOwnedPanel(ref, registration);
				if (!panel) return;
				panel.focused = false;
				setPiInteractiveComponentFocus(panel.component, false);
				renderCustomPanel(ref, panel, panel.hidden);
			},
			isFocused() {
				const panel = getOwnedPanel(ref, registration);
				return panel !== undefined && !panel.closed && panel.visible && !panel.hidden && panel.focused;
			},
		};
	}

	function showPiExtensionCustomPanel<T>(
		ref: SessionRef,
		factory: PiCustomFactory<T>,
		options?: PiCustomOptions,
	): Promise<T> {
		const key = sessionKey(ref);
		if (customPanelRegistrationsBySession.has(key) || customPanelsBySession.has(key)) {
			throw new Error("An extension custom UI is already active");
		}
		if (options?.overlay === false) throw createUnsupportedExtensionUiError("custom.overlay(false)");
		const resolveLayout = () => normalizeCustomOverlayLayout(options, getExtensionUiViewport(ref));
		const initialLayout = resolveLayout();
		return new Promise<T>((resolve, reject) => {
			const registration: CustomPanelRegistration = {
				generation: ++nextCustomPanelGeneration,
				closed: false,
				resolve: resolve as (result: unknown) => void,
				reject,
				pendingFactory: null,
			};
			customPanelRegistrationsBySession.set(key, registration);

			const initialViewport = getExtensionUiViewport(ref);
			let terminalColumns = initialViewport === undefined ? EXTENSION_UI_RENDER_WIDTH : initialViewport.columns;
			let terminalRows = initialViewport === undefined ? EXTENSION_UI_RENDER_ROWS : initialViewport.rows;
			const setTerminalGeometry = (columns: number, rows: number) => {
				terminalColumns = columns;
				terminalRows = rows;
			};
			const requestRender = () => {
				const panel = getOwnedPanel(ref, registration);
				if (!panel) return;
				try {
					renderCustomPanel(ref, panel, panel.hidden);
				} catch (error) {
					closeOwnedPanel(ref, registration, error, true);
				}
			};
			const done = (result: T) => closeOwnedPanel(ref, registration, result);
			registration.pendingFactory = {
				complete(created) {
					if (!ownsRegistration(ref, registration)) {
						disposeAbandonedFactoryValue(created);
						return;
					}
					try {
						assertInteractiveComponent(created, "custom");
					} catch (error) {
						disposeAbandonedFactoryValue(created);
						closeOwnedPanel(ref, registration, error, true);
						return;
					}
					const panel: ActiveCustomPanel = {
						registration,
						component: created,
						...initialLayout,
						resolveLayout,
						setTerminalGeometry,
						closed: false,
						hidden: false,
						focused: !initialLayout.layout.nonCapturing,
					};
					customPanelsBySession.set(key, panel);
					try {
						renderCustomPanel(ref, panel, false);
						if (!ownsRegistration(ref, registration)) return;
						options?.onHandle?.(createOverlayHandle(ref, registration));
					} catch (error) {
						closeOwnedPanel(ref, registration, error, true);
					}
				},
				fail(error) {
					closeOwnedPanel(ref, registration, error, true);
				},
			};
			let factoryResult: unknown;
			try {
				factoryResult = factory(
					createOffscreenWidgetTui(requestRender, "custom(component)", {
						getColumns: () => terminalColumns,
						getRows: () => terminalRows,
					}),
					getPiExtensionThemeProxy(ref),
					createLingKeybindings(),
					done,
				);
			} catch (error) {
				closeOwnedPanel(ref, registration, error, true);
				return;
			}

			// These reactions capture only the registration. Closing clears its heavy pending
			// state, so a factory Promise that never settles cannot pin layout/options/resolvers.
			void Promise.resolve(factoryResult).then(
				(created) => completeCustomPanelFactory(registration, created),
				(error) => failCustomPanelFactory(registration, error),
			);
		});
	}

	function rerenderPiExtensionCustomPanel(ref: SessionRef): void {
		const panel = customPanelsBySession.get(sessionKey(ref));
		if (panel && !panel.closed) renderCustomPanel(ref, panel, panel.hidden);
	}

	function disposePiExtensionCustomPanel(ref: SessionRef): void {
		const key = sessionKey(ref);
		if (customPanelRegistrationsBySession.has(key)) closePanel(ref, undefined);
	}

	/** Viewport geometry belongs to the retained Ling session, not one reloadable
	 * extension generation. Clear it only when that session identity is released. */
	function disposePiExtensionUiViewport(ref: SessionRef): void {
		forgetExtensionUiViewport(ref);
	}
	return {
		sendPiExtensionUiInput,
		updatePiExtensionUiViewport,
		showPiExtensionCustomPanel,
		rerenderPiExtensionCustomPanel,
		disposePiExtensionCustomPanel,
		disposePiExtensionUiViewport,
	};
}
