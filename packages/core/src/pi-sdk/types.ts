import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	AgentSessionServices,
	CreateAgentSessionOptions,
	CreateAgentSessionRuntimeFactory,
	ExtensionRuntime,
	ExtensionUIContext,
	InlineExtension,
	LoadExtensionsResult,
	ModelRuntime,
	ProgressEvent,
	PromptOptions,
	ReadonlyFooterDataProvider,
	ResourceLoader,
	SessionInfo,
	SessionManager,
	SettingsManager,
	Theme,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

export type PiAgentSession = AgentSession;
/**
 * What projecting a session branch reads from a session. An archived transcript is opened straight
 * from its file without a loaded project, so it carries no extension runner and its registered
 * renderers and markdown transformers do not apply.
 */
/** A live session projects with its own extensions; archived reads pass `extensions: null`. */
export function piBranchProjectionSource(session: AgentSession): PiBranchProjectionSource {
	return { sessionManager: session.sessionManager, extensions: session };
}

export interface PiBranchProjectionSource {
	sessionManager: AgentSession["sessionManager"];
	/** Null for an archived transcript: no project is loaded, so no extension renders its entries. */
	extensions: Pick<AgentSession, "extensionRunner" | "settingsManager"> | null;
}
export type PiAgentSessionRuntime = AgentSessionRuntime;
export type PiAgentSessionEvent = AgentSessionEvent;
export type PiAgentSessionServices = AgentSessionServices;
export type PiCreateAgentSessionOptions = CreateAgentSessionOptions;
export type PiCreateAgentSessionRuntimeFactory = CreateAgentSessionRuntimeFactory;
export type PiExtensionRuntime = ExtensionRuntime;
export type PiExtensionUiContext = ExtensionUIContext;
export type PiInlineExtension = InlineExtension;
export type PiLoadExtensionsResult = LoadExtensionsResult;
export type PiResourceLoader = ResourceLoader;
export type PiSessionInfo = SessionInfo;
export type PiSessionManager = SessionManager;
export type PiSettingsManager = SettingsManager;
export type PiTheme = Theme;
export type PiToolCallEvent = ToolCallEvent;
export type PiToolResultEvent = ToolResultEvent;

export type PiModel = ReturnType<ModelRuntime["getModels"]>[number];
type PiPromptOptions = NonNullable<PromptOptions>;
export type PiImageAttachment = NonNullable<PiPromptOptions["images"]>[number];
export type PiExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];
export type PiProgressEvent = ProgressEvent;
export type PiReadonlyFooterDataProvider = ReadonlyFooterDataProvider;
