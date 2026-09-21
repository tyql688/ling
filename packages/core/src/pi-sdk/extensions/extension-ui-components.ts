import { errorMessage } from "@ling/contracts/ling-error";
import {
	EXTENSION_UI_KEY_MAX_CHARS,
	EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS,
} from "@ling/contracts/session-extension-ui";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { createLogger } from "../../logger";
import {
	createUnsupportedExtensionUiError,
	type ExtensionUiBridge,
	unsupportedExtensionUi as unsupported,
} from "../../pi-protocol/extension-ui";
import type { PiReadonlyFooterDataProvider, PiTheme } from "../types";
import {
	type ExtensionUiCapabilities,
	type ExtensionUiCapability,
	staleExtensionUiContext,
} from "./extension-ui-capability";
import type { FooterDataProviderLease, PiExtensionFooterData } from "./extension-ui-footer-data";
import { createOffscreenWidgetTui } from "./extension-ui-offscreen-tui";
import {
	assertPiRenderedLines,
	isPiWidgetComponent,
	type PiWidgetComponent,
	renderPiComponentLines,
} from "./extension-ui-renderable";
import { lingWidgetTheme } from "./extension-ui-theme";
import type { ExtensionUiViewports } from "./extension-ui-viewport";

const log = createLogger("pi-extension-ui-components");

type PiWidgetFactory = (tui: unknown, theme: PiTheme) => unknown;
export type PiHeaderFactory = (tui: unknown, theme: PiTheme) => unknown;
export type PiFooterFactory = (tui: unknown, theme: PiTheme, footerData: PiReadonlyFooterDataProvider) => unknown;
export type PiInteractiveComponent = PiWidgetComponent & {
	handleInput?(data: string): void;
	focused?: boolean;
	wantsKeyRelease?: boolean;
	width?: number;
};

export interface PiExtensionUiContextOptions {
	getAvailableProviderCount?: () => number;
	getThemes?: () => readonly PiTheme[];
}

interface ActiveWidgetComponent {
	key: string;
	component: PiWidgetComponent;
	placement: "aboveComposer" | "belowComposer";
}

interface ActiveFooterComponent {
	component: PiWidgetComponent;
	dataLease: FooterDataProviderLease;
}

function widgetPlacement(placement: "aboveEditor" | "belowEditor" | undefined): "aboveComposer" | "belowComposer" {
	return placement === "belowEditor" ? "belowComposer" : "aboveComposer";
}

function disposeUnknownComponent(label: string, value: unknown, failures?: unknown[]): void {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
	try {
		const dispose = Reflect.get(value, "dispose");
		if (typeof dispose === "function") Reflect.apply(dispose, value, []);
	} catch (error) {
		if (failures) failures.push(error);
		else log.error(`${label} dispose failed:`, error);
	}
}

export function disposePiWidgetComponent(label: string, component: PiWidgetComponent, failures?: unknown[]): void {
	disposeUnknownComponent(label, component, failures);
}

export function setPiInteractiveComponentFocus(component: PiInteractiveComponent, focused: boolean): void {
	if (!("focused" in component)) return;
	component.focused = focused;
}

function disposeWidgetComponent(entry: ActiveWidgetComponent, failures?: unknown[]): void {
	disposePiWidgetComponent(`extension widget ${entry.key}`, entry.component, failures);
}

function assertWidgetComponent(value: unknown): asserts value is PiWidgetComponent {
	if (!isPiWidgetComponent(value)) unsupported("setWidget(component)");
}

function assertWidgetLines(value: unknown): asserts value is string[] {
	assertPiRenderedLines(value, () => createUnsupportedExtensionUiError("setWidget(component).render"));
}

export function getPiSdkThemes(options: PiExtensionUiContextOptions): readonly PiTheme[] {
	if (!options.getThemes) unsupported("themeRegistry");
	return options.getThemes();
}

type PiExtensionComponentStateDependencies = {
	bridge: ExtensionUiBridge;
	capabilities: ExtensionUiCapabilities;
	footerData: PiExtensionFooterData;
	viewports: ExtensionUiViewports;
};

interface PiExtensionComponentState {
	emitExtensionUiState: PiExtensionComponentStateDependencies["bridge"]["emitExtensionUiState"];
	getExtensionUiState: PiExtensionComponentStateDependencies["bridge"]["getExtensionUiState"];
	assertActiveExtensionUiCapability: PiExtensionComponentStateDependencies["capabilities"]["assertActiveExtensionUiCapability"];
	createFooterDataProviderLease: PiExtensionComponentStateDependencies["footerData"]["createFooterDataProviderLease"];
	headerRenderColumns: PiExtensionComponentStateDependencies["viewports"]["headerRenderColumns"];
	widgetRenderColumns: PiExtensionComponentStateDependencies["viewports"]["widgetRenderColumns"];
	widgetComponentsBySession: Map<string, Map<string, ActiveWidgetComponent>>;
	headerComponentsBySession: Map<string, PiWidgetComponent>;
	footerComponentsBySession: Map<string, ActiveFooterComponent>;
	themeBySession: Map<string, PiTheme>;
	themeProxyBySession: Map<string, { capability: ExtensionUiCapability; proxy: PiTheme }>;
	widgetRevisionBySession: Map<string, Map<string, number>>;
	headerRevisionBySession: Map<string, number>;
	footerRevisionBySession: Map<string, number>;
	nextComponentRevision: number;
}

export function createPiExtensionComponents({
	bridge,
	capabilities,
	footerData,
	viewports,
}: PiExtensionComponentStateDependencies) {
	const owner: PiExtensionComponentState = {
		emitExtensionUiState: bridge.emitExtensionUiState,
		getExtensionUiState: bridge.getExtensionUiState,
		assertActiveExtensionUiCapability: capabilities.assertActiveExtensionUiCapability,
		createFooterDataProviderLease: footerData.createFooterDataProviderLease,
		headerRenderColumns: viewports.headerRenderColumns,
		widgetRenderColumns: viewports.widgetRenderColumns,
		widgetComponentsBySession: new Map<string, Map<string, ActiveWidgetComponent>>(),
		headerComponentsBySession: new Map<string, PiWidgetComponent>(),
		footerComponentsBySession: new Map<string, ActiveFooterComponent>(),
		themeBySession: new Map<string, PiTheme>(),
		themeProxyBySession: new Map<string, { capability: ExtensionUiCapability; proxy: PiTheme }>(),
		widgetRevisionBySession: new Map<string, Map<string, number>>(),
		headerRevisionBySession: new Map<string, number>(),
		footerRevisionBySession: new Map<string, number>(),
		nextComponentRevision: 0,
	};
	return {
		createPiExtensionThemeProxy(ref: SessionRef, capability: ExtensionUiCapability): PiTheme {
			return createPiExtensionThemeProxy(owner, ref, capability);
		},
		getPiExtensionThemeProxy(ref: SessionRef): PiTheme {
			return getPiExtensionThemeProxy(owner, ref);
		},
		setPiExtensionWidget(
			ref: SessionRef,
			key: string,
			content: unknown,
			placement: "aboveEditor" | "belowEditor" | undefined,
		): void {
			return setPiExtensionWidget(owner, ref, key, content, placement);
		},
		setPiExtensionHeader(ref: SessionRef, factory: PiHeaderFactory | undefined): void {
			return setPiExtensionHeader(owner, ref, factory);
		},
		setPiExtensionFooter(
			ref: SessionRef,
			factory: PiFooterFactory | undefined,
			options: PiExtensionUiContextOptions,
			capability: ExtensionUiCapability,
		): void {
			return setPiExtensionFooter(owner, ref, factory, options, capability);
		},
		setPiExtensionTheme(ref: SessionRef, theme: PiTheme): void {
			return setPiExtensionTheme(owner, ref, theme);
		},
		rerenderPiExtensionComponents(ref: SessionRef): void {
			return rerenderPiExtensionComponents(owner, ref);
		},
		rerenderPiExtensionFooter(ref: SessionRef): void {
			return rerenderPiExtensionFooter(owner, ref);
		},
		disposePiExtensionComponents(ref: SessionRef, failures: unknown[]): void {
			return disposePiExtensionComponents(owner, ref, failures);
		},
	};
}

function widgetComponents(owner: PiExtensionComponentState, ref: SessionRef): Map<string, ActiveWidgetComponent> {
	const key = sessionKey(ref);
	const existing = owner.widgetComponentsBySession.get(key);
	if (existing) return existing;
	const created = new Map<string, ActiveWidgetComponent>();
	owner.widgetComponentsBySession.set(key, created);
	return created;
}

function currentTheme(owner: PiExtensionComponentState, ref: SessionRef): PiTheme {
	const theme = owner.themeBySession.get(sessionKey(ref));
	return theme === undefined ? lingWidgetTheme : theme;
}

function createPiExtensionThemeProxy(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	capability: ExtensionUiCapability,
): PiTheme {
	const key = sessionKey(ref);
	const proxy: PiTheme = new Proxy(lingWidgetTheme, {
		get(_target, property, receiver) {
			const active = owner.themeProxyBySession.get(key);
			if (active?.proxy !== proxy || active.capability !== capability) {
				throw staleExtensionUiContext();
			}
			owner.assertActiveExtensionUiCapability(capability);
			const value = Reflect.get(currentTheme(owner, ref), property, receiver);
			if (property === "constructor") return value;
			return typeof value === "function" ? value.bind(currentTheme(owner, ref)) : value;
		},
	});
	owner.themeProxyBySession.set(key, { capability, proxy });
	return proxy;
}

function getPiExtensionThemeProxy(owner: PiExtensionComponentState, ref: SessionRef): PiTheme {
	const active = owner.themeProxyBySession.get(sessionKey(ref));
	if (!active) throw staleExtensionUiContext();
	owner.assertActiveExtensionUiCapability(active.capability);
	return active.proxy;
}

function beginWidgetRevision(owner: PiExtensionComponentState, ref: SessionRef, key: string): number {
	const session = sessionKey(ref);
	const revisions = owner.widgetRevisionBySession.get(session);
	const revision = ++owner.nextComponentRevision;
	if (revisions) revisions.set(key, revision);
	else owner.widgetRevisionBySession.set(session, new Map([[key, revision]]));
	return revision;
}

function finishWidgetRevision(owner: PiExtensionComponentState, ref: SessionRef, key: string, revision: number): void {
	const session = sessionKey(ref);
	const revisions = owner.widgetRevisionBySession.get(session);
	if (revisions?.get(key) !== revision) return;
	revisions.delete(key);
	if (revisions.size === 0) owner.widgetRevisionBySession.delete(session);
}

function ownsWidgetRevision(owner: PiExtensionComponentState, ref: SessionRef, key: string, revision: number): boolean {
	return owner.widgetRevisionBySession.get(sessionKey(ref))?.get(key) === revision;
}

function beginHeaderRevision(owner: PiExtensionComponentState, ref: SessionRef): number {
	const revision = ++owner.nextComponentRevision;
	owner.headerRevisionBySession.set(sessionKey(ref), revision);
	return revision;
}

function ownsHeaderRevision(owner: PiExtensionComponentState, ref: SessionRef, revision: number): boolean {
	return owner.headerRevisionBySession.get(sessionKey(ref)) === revision;
}

function finishHeaderRevision(owner: PiExtensionComponentState, ref: SessionRef, revision: number): void {
	const key = sessionKey(ref);
	if (owner.headerRevisionBySession.get(key) === revision) owner.headerRevisionBySession.delete(key);
}

function beginFooterRevision(owner: PiExtensionComponentState, ref: SessionRef): number {
	const revision = ++owner.nextComponentRevision;
	owner.footerRevisionBySession.set(sessionKey(ref), revision);
	return revision;
}

function ownsFooterRevision(owner: PiExtensionComponentState, ref: SessionRef, revision: number): boolean {
	return owner.footerRevisionBySession.get(sessionKey(ref)) === revision;
}

function finishFooterRevision(owner: PiExtensionComponentState, ref: SessionRef, revision: number): void {
	const key = sessionKey(ref);
	if (owner.footerRevisionBySession.get(key) === revision) owner.footerRevisionBySession.delete(key);
}

function ownsWidgetComponent(owner: PiExtensionComponentState, ref: SessionRef, entry: ActiveWidgetComponent): boolean {
	return owner.widgetComponentsBySession.get(sessionKey(ref))?.get(entry.key) === entry;
}

function removeWidgetComponent(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	key: string,
	expected?: ActiveWidgetComponent,
): void {
	const session = sessionKey(ref);
	const components = owner.widgetComponentsBySession.get(session);
	if (!components) return;
	const existing = components.get(key);
	if (!existing || (expected && existing !== expected)) return;
	// Revoke ownership before calling extension code in dispose(). A disposed old
	// component may synchronously install a replacement under the same key.
	components.delete(key);
	if (components.size === 0 && owner.widgetComponentsBySession.get(session) === components) {
		owner.widgetComponentsBySession.delete(session);
	}
	disposeWidgetComponent(existing);
}

function removeHeaderComponent(owner: PiExtensionComponentState, ref: SessionRef, failures?: unknown[]): void {
	const key = sessionKey(ref);
	const existing = owner.headerComponentsBySession.get(key);
	if (!existing) return;
	owner.headerComponentsBySession.delete(key);
	disposePiWidgetComponent("extension header", existing, failures);
}

function removeFooterComponent(owner: PiExtensionComponentState, ref: SessionRef, failures?: unknown[]): void {
	const key = sessionKey(ref);
	const existing = owner.footerComponentsBySession.get(key);
	if (!existing) return;
	owner.footerComponentsBySession.delete(key);
	disposePiWidgetComponent("extension footer", existing.component, failures);
	try {
		existing.dataLease.dispose();
	} catch (error) {
		if (failures) failures.push(error);
		else log.error("extension footer data dispose failed:", error);
	}
}

/**
 * A TUI component draws to an exact column count, so it must be given the width of the surface it
 * will actually appear on: widgets and the footer render inside the extension dock, the header
 * inline at the top of the transcript. Passing one fixed width is what clipped dock lines.
 */
function renderWidgetComponent(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	component: PiWidgetComponent,
	capability = "setWidget(component)",
): string[] {
	const columns = capability.startsWith("setHeader") ? owner.headerRenderColumns(ref) : owner.widgetRenderColumns(ref);
	return renderPiComponentLines(component, columns, () => createUnsupportedExtensionUiError(`${capability}.render`));
}

function renderActiveWidget(owner: PiExtensionComponentState, ref: SessionRef, entry: ActiveWidgetComponent): void {
	if (!ownsWidgetComponent(owner, ref, entry)) return;
	const lines = renderWidgetComponent(owner, ref, entry.component);
	if (!ownsWidgetComponent(owner, ref, entry)) return;
	owner.emitExtensionUiState(ref, {
		type: "widget",
		key: entry.key,
		lines,
		placement: entry.placement,
	});
}

function failWidgetRender(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	entry: ActiveWidgetComponent,
	error: unknown,
): void {
	if (!ownsWidgetComponent(owner, ref, entry)) return;
	removeWidgetComponent(owner, ref, entry.key, entry);
	if (owner.widgetComponentsBySession.get(sessionKey(ref))?.has(entry.key)) return;
	owner.emitExtensionUiState(ref, { type: "widget", key: entry.key, lines: [], placement: null });
	owner.emitExtensionUiState(ref, {
		type: "notify",
		level: "error",
		message: errorMessage(error),
	});
}

function setComponentWidgetValue(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	key: string,
	placement: "aboveComposer" | "belowComposer",
	revision: number,
	createComponent: (requestRender: () => void) => unknown,
): void {
	let entry: ActiveWidgetComponent | undefined;
	const requestRender = () => {
		if (!entry || !ownsWidgetComponent(owner, ref, entry)) return;
		try {
			renderActiveWidget(owner, ref, entry);
		} catch (error) {
			failWidgetRender(owner, ref, entry, error);
		}
	};
	const component = createComponent(requestRender);
	try {
		assertWidgetComponent(component);
	} catch (error) {
		disposeUnknownComponent("invalid extension widget", component);
		throw error;
	}
	const nextEntry = { key, component, placement };
	let lines: string[];
	try {
		lines = renderWidgetComponent(owner, ref, component);
	} catch (error) {
		disposeWidgetComponent(nextEntry);
		throw error;
	}
	entry = nextEntry;
	if (!ownsWidgetRevision(owner, ref, key, revision)) {
		disposeWidgetComponent(nextEntry);
		return;
	}
	removeWidgetComponent(owner, ref, key);
	if (!ownsWidgetRevision(owner, ref, key, revision)) {
		disposeWidgetComponent(nextEntry);
		return;
	}
	widgetComponents(owner, ref).set(key, nextEntry);
	try {
		owner.emitExtensionUiState(ref, { type: "widget", key, lines, placement });
	} catch (error) {
		removeWidgetComponent(owner, ref, key, nextEntry);
		throw error;
	}
}

function setComponentWidget(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	key: string,
	factory: PiWidgetFactory,
	placement: "aboveComposer" | "belowComposer",
	revision: number,
): void {
	setComponentWidgetValue(owner, ref, key, placement, revision, (requestRender) =>
		factory(createOffscreenWidgetTui(requestRender), getPiExtensionThemeProxy(owner, ref)),
	);
}

function setComponentWidgetInstance(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	key: string,
	component: PiWidgetComponent,
	placement: "aboveComposer" | "belowComposer",
	revision: number,
): void {
	setComponentWidgetValue(owner, ref, key, placement, revision, () => component);
}

function rerenderComponentWidgets(owner: PiExtensionComponentState, ref: SessionRef): void {
	const components = owner.widgetComponentsBySession.get(sessionKey(ref));
	if (!components) return;
	for (const entry of [...components.values()]) {
		try {
			renderActiveWidget(owner, ref, entry);
		} catch (error) {
			failWidgetRender(owner, ref, entry, error);
		}
	}
}

function setPiExtensionWidget(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	key: string,
	content: unknown,
	placement: "aboveEditor" | "belowEditor" | undefined,
): void {
	if (key.length > EXTENSION_UI_KEY_MAX_CHARS) unsupported("setWidget.key");
	const state = owner.getExtensionUiState(ref);
	if (
		content !== undefined &&
		!state.widgets.some((widget) => widget.key === key) &&
		state.widgets.length >= EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS
	) {
		unsupported("setWidget.count");
	}
	const revision = beginWidgetRevision(owner, ref, key);
	try {
		if (content === undefined) {
			removeWidgetComponent(owner, ref, key);
			if (!ownsWidgetRevision(owner, ref, key, revision)) return;
			owner.emitExtensionUiState(ref, { type: "widget", key, lines: [], placement: null });
			return;
		}
		if (typeof content === "function") {
			setComponentWidget(owner, ref, key, content as PiWidgetFactory, widgetPlacement(placement), revision);
			return;
		}
		if (isPiWidgetComponent(content)) {
			setComponentWidgetInstance(owner, ref, key, content, widgetPlacement(placement), revision);
			return;
		}
		if (!Array.isArray(content)) unsupported("setWidget");
		assertWidgetLines(content);
		removeWidgetComponent(owner, ref, key);
		if (!ownsWidgetRevision(owner, ref, key, revision)) return;
		owner.emitExtensionUiState(ref, {
			type: "widget",
			key,
			lines: content,
			placement: widgetPlacement(placement),
		});
	} finally {
		finishWidgetRevision(owner, ref, key, revision);
	}
}

function setHeaderComponent(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	factory: PiHeaderFactory,
	revision: number,
): void {
	let component: PiWidgetComponent | undefined;
	// A replaced component's render requests are ignored.
	const requestRender = () => {
		if (component && owner.headerComponentsBySession.get(sessionKey(ref)) === component)
			rerenderHeaderComponent(owner, ref);
	};
	const nextComponent = factory(
		createOffscreenWidgetTui(requestRender, "setHeader(component)"),
		getPiExtensionThemeProxy(owner, ref),
	);
	try {
		assertWidgetComponent(nextComponent);
	} catch (error) {
		disposeUnknownComponent("invalid extension header", nextComponent);
		throw error;
	}
	let lines: string[];
	try {
		lines = renderWidgetComponent(owner, ref, nextComponent, "setHeader(component)");
	} catch (error) {
		disposePiWidgetComponent("extension header", nextComponent);
		throw error;
	}
	if (!ownsHeaderRevision(owner, ref, revision)) {
		disposePiWidgetComponent("extension header", nextComponent);
		return;
	}
	removeHeaderComponent(owner, ref);
	if (!ownsHeaderRevision(owner, ref, revision)) {
		disposePiWidgetComponent("extension header", nextComponent);
		return;
	}
	component = nextComponent;
	owner.headerComponentsBySession.set(sessionKey(ref), nextComponent);
	owner.emitExtensionUiState(ref, { type: "header", lines });
}

function rerenderHeaderComponent(owner: PiExtensionComponentState, ref: SessionRef): void {
	const key = sessionKey(ref);
	const component = owner.headerComponentsBySession.get(key);
	if (!component) return;
	try {
		const lines = renderWidgetComponent(owner, ref, component, "setHeader(component)");
		if (owner.headerComponentsBySession.get(key) !== component) return;
		owner.emitExtensionUiState(ref, { type: "header", lines });
	} catch (error) {
		if (owner.headerComponentsBySession.get(key) !== component) return;
		removeHeaderComponent(owner, ref);
		if (owner.headerComponentsBySession.has(key)) return;
		owner.emitExtensionUiState(ref, { type: "header", lines: null });
		owner.emitExtensionUiState(ref, { type: "notify", level: "error", message: errorMessage(error) });
	}
}

function setPiExtensionHeader(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	factory: PiHeaderFactory | undefined,
): void {
	const revision = beginHeaderRevision(owner, ref);
	try {
		if (factory === undefined) {
			removeHeaderComponent(owner, ref);
			if (!ownsHeaderRevision(owner, ref, revision)) return;
			owner.emitExtensionUiState(ref, { type: "header", lines: null });
			return;
		}
		setHeaderComponent(owner, ref, factory, revision);
	} finally {
		finishHeaderRevision(owner, ref, revision);
	}
}

function setFooterComponent(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	factory: PiFooterFactory,
	options: PiExtensionUiContextOptions,
	capability: ExtensionUiCapability,
	revision: number,
): void {
	let entry: ActiveFooterComponent | undefined;
	// A replaced component's render requests are ignored.
	const requestRender = () => {
		if (entry && owner.footerComponentsBySession.get(sessionKey(ref)) === entry) rerenderFooterComponent(owner, ref);
	};
	const dataLease = owner.createFooterDataProviderLease(ref, {
		...options,
		onBranchChanged: () => rerenderFooterComponent(owner, ref),
		assertActive: () => owner.assertActiveExtensionUiCapability(capability),
	});
	let nextComponent: unknown;
	try {
		nextComponent = factory(
			createOffscreenWidgetTui(requestRender, "setFooter(component)"),
			getPiExtensionThemeProxy(owner, ref),
			dataLease.provider,
		);
		assertWidgetComponent(nextComponent);
	} catch (error) {
		disposeUnknownComponent("invalid extension footer", nextComponent);
		dataLease.dispose();
		throw error;
	}
	const nextEntry: ActiveFooterComponent = { component: nextComponent, dataLease };
	let lines: string[];
	try {
		lines = renderWidgetComponent(owner, ref, nextComponent, "setFooter(component)");
	} catch (error) {
		disposePiWidgetComponent("extension footer", nextComponent);
		dataLease.dispose();
		throw error;
	}
	if (!ownsFooterRevision(owner, ref, revision)) {
		disposePiWidgetComponent("extension footer", nextComponent);
		dataLease.dispose();
		return;
	}
	removeFooterComponent(owner, ref);
	if (!ownsFooterRevision(owner, ref, revision)) {
		disposePiWidgetComponent("extension footer", nextComponent);
		dataLease.dispose();
		return;
	}
	entry = nextEntry;
	owner.footerComponentsBySession.set(sessionKey(ref), nextEntry);
	try {
		owner.emitExtensionUiState(ref, { type: "footer", lines });
	} catch (error) {
		removeFooterComponent(owner, ref);
		throw error;
	}
}

function rerenderFooterComponent(owner: PiExtensionComponentState, ref: SessionRef): void {
	const key = sessionKey(ref);
	const entry = owner.footerComponentsBySession.get(key);
	if (!entry) return;
	try {
		const lines = renderWidgetComponent(owner, ref, entry.component, "setFooter(component)");
		if (owner.footerComponentsBySession.get(key) !== entry) return;
		owner.emitExtensionUiState(ref, { type: "footer", lines });
	} catch (error) {
		if (owner.footerComponentsBySession.get(key) !== entry) return;
		removeFooterComponent(owner, ref);
		if (owner.footerComponentsBySession.has(key)) return;
		owner.emitExtensionUiState(ref, { type: "footer", lines: null });
		owner.emitExtensionUiState(ref, { type: "notify", level: "error", message: errorMessage(error) });
	}
}

function setPiExtensionFooter(
	owner: PiExtensionComponentState,
	ref: SessionRef,
	factory: PiFooterFactory | undefined,
	options: PiExtensionUiContextOptions,
	capability: ExtensionUiCapability,
): void {
	const revision = beginFooterRevision(owner, ref);
	try {
		if (factory === undefined) {
			removeFooterComponent(owner, ref);
			if (!ownsFooterRevision(owner, ref, revision)) return;
			owner.emitExtensionUiState(ref, { type: "footer", lines: null });
			return;
		}
		setFooterComponent(owner, ref, factory, options, capability, revision);
	} finally {
		finishFooterRevision(owner, ref, revision);
	}
}

function setPiExtensionTheme(owner: PiExtensionComponentState, ref: SessionRef, theme: PiTheme): void {
	owner.themeBySession.set(sessionKey(ref), theme);
	rerenderComponentWidgets(owner, ref);
	rerenderHeaderComponent(owner, ref);
	rerenderFooterComponent(owner, ref);
}

function rerenderPiExtensionComponents(owner: PiExtensionComponentState, ref: SessionRef): void {
	rerenderComponentWidgets(owner, ref);
	rerenderHeaderComponent(owner, ref);
	rerenderFooterComponent(owner, ref);
}

function rerenderPiExtensionFooter(owner: PiExtensionComponentState, ref: SessionRef): void {
	rerenderFooterComponent(owner, ref);
}

function disposePiExtensionComponents(owner: PiExtensionComponentState, ref: SessionRef, failures: unknown[]): void {
	const key = sessionKey(ref);
	const components = owner.widgetComponentsBySession.get(key);
	if (components) {
		owner.widgetComponentsBySession.delete(key);
		for (const entry of components.values()) disposeWidgetComponent(entry, failures);
	}
	removeHeaderComponent(owner, ref, failures);
	removeFooterComponent(owner, ref, failures);
	owner.themeBySession.delete(key);
	owner.themeProxyBySession.delete(key);
	owner.widgetRevisionBySession.delete(key);
	owner.headerRevisionBySession.delete(key);
	owner.footerRevisionBySession.delete(key);
}

export type PiExtensionComponents = ReturnType<typeof createPiExtensionComponents>;
