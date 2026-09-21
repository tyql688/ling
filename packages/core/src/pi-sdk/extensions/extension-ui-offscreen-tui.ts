import { createUnsupportedExtensionUiError } from "../../pi-protocol/extension-ui";
import { EXTENSION_UI_RENDER_ROWS, EXTENSION_UI_RENDER_WIDTH } from "./extension-ui-overlay-layout";

interface OffscreenTuiGeometry {
	getColumns?: () => number;
	getRows?: () => number;
}

function unsupportedOffscreenTui(ownerCapability: string, capability: string): never {
	throw createUnsupportedExtensionUiError(`${ownerCapability}.${capability}`);
}

function unsupportedOffscreenTuiMethod(ownerCapability: string, capability: string): () => never {
	return () => unsupportedOffscreenTui(ownerCapability, capability);
}

function unsupportedOffscreenTuiAsyncMethod(ownerCapability: string, capability: string): () => Promise<never> {
	return async () => unsupportedOffscreenTui(ownerCapability, capability);
}

function unsupportedUnknownProperty(target: object, ownerCapability: string, capability: string): object {
	return new Proxy(target, {
		get(value, property, receiver) {
			if (typeof property === "symbol") return Reflect.get(value, property, receiver);
			if (property in value) return Reflect.get(value, property, receiver);
			unsupportedOffscreenTui(ownerCapability, `${capability}.${property}`);
		},
	});
}

function terminalDimension(value: number | undefined, fallback: number, capability: string): number {
	const dimension = value === undefined ? fallback : value;
	if (!Number.isFinite(dimension) || dimension <= 0) {
		throw new Error(`Invalid extension TUI ${capability}`);
	}
	return Math.max(1, Math.floor(dimension));
}

export function createOffscreenWidgetTui(
	requestRender: () => void,
	ownerCapability = "setWidget(component)",
	geometry: OffscreenTuiGeometry = {},
): unknown {
	const terminal = unsupportedUnknownProperty(
		{
			get columns() {
				return terminalDimension(geometry.getColumns?.(), EXTENSION_UI_RENDER_WIDTH, "terminal.columns");
			},
			get rows() {
				return terminalDimension(geometry.getRows?.(), EXTENSION_UI_RENDER_ROWS, "terminal.rows");
			},
			get kittyProtocolActive() {
				return false;
			},
			start: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.start"),
			stop: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.stop"),
			drainInput: unsupportedOffscreenTuiAsyncMethod(ownerCapability, "terminal.drainInput"),
			write: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.write"),
			moveBy: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.moveBy"),
			hideCursor: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.hideCursor"),
			showCursor: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.showCursor"),
			clearLine: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.clearLine"),
			clearFromCursor: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.clearFromCursor"),
			clearScreen: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.clearScreen"),
			setTitle: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.setTitle"),
			setProgress: unsupportedOffscreenTuiMethod(ownerCapability, "terminal.setProgress"),
		},
		ownerCapability,
		"tui.terminal",
	);

	return unsupportedUnknownProperty(
		{
			terminal,
			get fullRedraws() {
				return 0;
			},
			getShowHardwareCursor: () => false,
			getClearOnShrink: () => false,
			hasOverlay: () => false,
			invalidate: requestRender,
			requestRender,
			setShowHardwareCursor: unsupportedOffscreenTuiMethod(ownerCapability, "setShowHardwareCursor"),
			setClearOnShrink: unsupportedOffscreenTuiMethod(ownerCapability, "setClearOnShrink"),
			setFocus: unsupportedOffscreenTuiMethod(ownerCapability, "setFocus"),
			showOverlay: unsupportedOffscreenTuiMethod(ownerCapability, "showOverlay"),
			hideOverlay: unsupportedOffscreenTuiMethod(ownerCapability, "hideOverlay"),
			start: unsupportedOffscreenTuiMethod(ownerCapability, "start"),
			stop: unsupportedOffscreenTuiMethod(ownerCapability, "stop"),
			addInputListener: unsupportedOffscreenTuiMethod(ownerCapability, "addInputListener"),
			removeInputListener: unsupportedOffscreenTuiMethod(ownerCapability, "removeInputListener"),
			onTerminalColorSchemeChange: unsupportedOffscreenTuiMethod(ownerCapability, "onTerminalColorSchemeChange"),
			setTerminalColorSchemeNotifications: unsupportedOffscreenTuiMethod(
				ownerCapability,
				"setTerminalColorSchemeNotifications",
			),
			queryTerminalBackgroundColor: unsupportedOffscreenTuiAsyncMethod(ownerCapability, "queryTerminalBackgroundColor"),
			queryTerminalColorScheme: unsupportedOffscreenTuiAsyncMethod(ownerCapability, "queryTerminalColorScheme"),
		},
		ownerCapability,
		"tui",
	);
}
