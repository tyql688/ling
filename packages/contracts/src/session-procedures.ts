import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import type { SessionRef } from "./session-ref";
import { sessionRefSchema } from "./session-ref";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
import { createProjectFileSchemas } from "./project-file-requests";
import type {
	ApprovalRequest,
	CancelSessionOperationRequest,
	CancelSessionOperationResponse,
	CompactSessionRequest,
	ComposerHistoryEntry,
	ComposerHistoryStatus,
	CreateSessionRequest,
	DialogDismissEvent,
	EditQueuedRequest,
	ExtensionUiRequest,
	ForkSessionRequest,
	ListComposerHistoryRequest,
	ModelState,
	PromoteQueuedRequest,
	ReadSessionCompanionRequest,
	ReadToolResultRequest,
	ArchivedTranscript,
	ReadArchivedTranscriptRequest,
	ReadTranscriptPageRequest,
	ReadTranscriptPageResponse,
	RenameSessionRequest,
	ResumeSessionRequest,
	ResumeSessionResponse,
	RewindSessionRequest,
	RuntimeCommandCatalogSnapshot,
	RuntimeExtensionUiSnapshot,
	SendMessageRequest,
	SessionCatalogStatus,
	SessionCatalogChange,
	SessionDeletionOutcome,
	SessionEventEnvelope,
	SessionRuntimeSuspendedEvent,
	SessionSnapshot,
	SessionSnapshotRequest,
	SessionSummary,
	SessionTitleChangedEvent,
	SetSessionArchivedRequest,
	SetSessionModelRequest,
	SetSessionPinnedRequest,
	SetSessionThinkingLevelRequest,
} from "./session";
import type {
	ApplyExtensionAutocompleteRequest,
	ApplyExtensionAutocompleteResult,
	ExtensionAutocompleteRequest,
	ExtensionAutocompleteSuggestions,
	ExtensionTerminalInputResult,
	ExtensionUiEditorTextRequest,
	ExtensionUiInputRequest,
	ExtensionUiViewportRequest,
	SessionCommandArgumentCompletionRequest,
	SessionRuntimeBindingRequest,
} from "./session-extension-ui";
import type { ToolResultSessionMessage } from "./session-messages";
import { createSessionRequestSchemas } from "./session-requests";
import { viewedSessionRefSchema } from "./session-shell-validation";
export function createSessionProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const nativeRef = sessionRefSchema.extend({ cwd: paths.absolute("Project path") });
	const schemas = {
		...createSessionRequestSchemas({
			projectPath: paths.absolute("Project path"),
			sessionRef: nativeRef,
			fileReference: createProjectFileSchemas(paths.absolute, paths.windows).projectFileReferenceTargetSchema,
		}),
		sessionRefSchema: nativeRef,
		viewedSessionRefSchema,
	};
	return {
		create: request(
			"session:create",
			argumentsOf<[request: CreateSessionRequest]>((args) => [schemas.createSessionRequestSchema.parse(args[0])]),
			returns<SessionSummary>(),
		),
		list: request("session:list", noArguments, returns<SessionSummary[]>()),
		catalogStatus: request(
			"session:catalogStatus",
			argumentsOf<[]>((args) => {
				schemas.emptySessionRequestSchema.parse(args[0]);
				return [];
			}),
			returns<SessionCatalogStatus>(),
		),
		retryCatalogPersistence: request(
			"session:retryCatalogPersistence",
			argumentsOf<[]>((args) => {
				schemas.emptySessionRequestSchema.parse(args[0]);
				return [];
			}),
			returns<SessionCatalogStatus>(),
		),
		rebuildCatalog: request(
			"session:rebuildCatalog",
			argumentsOf<[]>((args) => {
				schemas.emptySessionRequestSchema.parse(args[0]);
				return [];
			}),
			returns<void>(),
		),
		resume: request(
			"session:resume",
			argumentsOf<[request: ResumeSessionRequest]>((args) => [schemas.resumeSessionRequestSchema.parse(args[0])]),
			returns<ResumeSessionResponse>(),
		),
		setViewedSession: request(
			"session:setViewedSession",
			argumentsOf<[ref: SessionRef | null]>((args) => [schemas.viewedSessionRefSchema.parse(args[0])]),
			returns<void>(),
		),
		delete: request(
			"session:delete",
			argumentsOf<[ref: SessionRef]>((args) => [schemas.sessionRefSchema.parse(args[0])]),
			returns<SessionDeletionOutcome>(),
		),
		sendMessage: request(
			"session:sendMessage",
			argumentsOf<[request: SendMessageRequest]>((args) => [schemas.sendMessageRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		listComposerHistory: request(
			"session:listComposerHistory",
			argumentsOf<[request: ListComposerHistoryRequest]>((args) => [
				schemas.listComposerHistoryRequestSchema.parse(args[0]),
			]),
			returns<ComposerHistoryEntry[]>(),
		),
		composerHistoryStatus: request(
			"session:composerHistoryStatus",
			argumentsOf<[]>((args) => {
				schemas.emptySessionRequestSchema.parse(args[0]);
				return [];
			}),
			returns<ComposerHistoryStatus>(),
		),
		retryComposerHistory: request(
			"session:retryComposerHistory",
			argumentsOf<[]>((args) => {
				schemas.emptySessionRequestSchema.parse(args[0]);
				return [];
			}),
			returns<ComposerHistoryStatus>(),
		),
		clearComposerHistory: request(
			"session:clearComposerHistory",
			argumentsOf<[]>((args) => {
				schemas.emptySessionRequestSchema.parse(args[0]);
				return [];
			}),
			returns<ComposerHistoryStatus>(),
		),
		abort: request(
			"session:abort",
			argumentsOf<[ref: SessionRef]>((args) => [schemas.sessionRefSchema.parse(args[0])]),
			returns<{ restoredTexts: string[] }>(),
		),
		editQueued: request(
			"session:editQueued",
			argumentsOf<[request: EditQueuedRequest]>((args) => [schemas.editQueuedRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		readCommandCatalog: request(
			"session:readCommandCatalog",
			argumentsOf<[request: ReadSessionCompanionRequest]>((args) => [
				schemas.readSessionCompanionRequestSchema.parse(args[0]),
			]),
			returns<RuntimeCommandCatalogSnapshot>(),
		),
		readExtensionUiState: request(
			"session:readExtensionUiState",
			argumentsOf<[request: ReadSessionCompanionRequest]>((args) => [
				schemas.readSessionCompanionRequestSchema.parse(args[0]),
			]),
			returns<RuntimeExtensionUiSnapshot>(),
		),
		listCommandArgumentCompletions: request(
			"session:listCommandArgumentCompletions",
			argumentsOf<[request: SessionCommandArgumentCompletionRequest]>((args) => [
				schemas.sessionCommandArgumentCompletionRequestSchema.parse(args[0]),
			]),
			returns<ExtensionAutocompleteSuggestions | null>(),
		),
		promoteQueued: request(
			"session:promoteQueued",
			argumentsOf<[request: PromoteQueuedRequest]>((args) => [schemas.promoteQueuedRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		getSnapshot: request(
			"session:getSnapshot",
			argumentsOf<[request: SessionSnapshotRequest]>((args) => [schemas.sessionSnapshotRequestSchema.parse(args[0])]),
			returns<SessionSnapshot>(),
		),
		readTranscriptPage: request(
			"session:readTranscriptPage",
			argumentsOf<[request: ReadTranscriptPageRequest]>((args) => [
				schemas.readTranscriptPageRequestSchema.parse(args[0]),
			]),
			returns<ReadTranscriptPageResponse>(),
		),
		readArchivedTranscript: request(
			"session:readArchivedTranscript",
			argumentsOf<[request: ReadArchivedTranscriptRequest]>((args) => [
				schemas.readArchivedTranscriptRequestSchema.parse(args[0]),
			]),
			returns<ArchivedTranscript>(),
		),
		readToolResult: request(
			"session:readToolResult",
			argumentsOf<[request: ReadToolResultRequest]>((args) => [schemas.readToolResultRequestSchema.parse(args[0])]),
			returns<ToolResultSessionMessage>(),
		),
		cancelRequest: request(
			"session:cancelRequest",
			argumentsOf<[request: CancelSessionOperationRequest]>((args) => [
				schemas.cancelSessionOperationRequestSchema.parse(args[0]),
			]),
			returns<CancelSessionOperationResponse>(),
		),
		getModelState: request(
			"session:getModelState",
			argumentsOf<[request: SessionRuntimeBindingRequest]>((args) => [
				schemas.sessionRuntimeBindingRequestSchema.parse(args[0]),
			]),
			returns<ModelState>(),
		),
		setModel: request(
			"session:setModel",
			argumentsOf<[request: SetSessionModelRequest]>((args) => [schemas.setSessionModelRequestSchema.parse(args[0])]),
			returns<ModelState>(),
		),
		setThinkingLevel: request(
			"session:setThinkingLevel",
			argumentsOf<[request: SetSessionThinkingLevelRequest]>((args) => [
				schemas.setSessionThinkingLevelRequestSchema.parse(args[0]),
			]),
			returns<ModelState>(),
		),
		getBranchLeaf: request(
			"session:getBranchLeaf",
			argumentsOf<[ref: SessionRef]>((args) => [schemas.sessionRefSchema.parse(args[0])]),
			returns<string | null>(),
		),
		setArchived: request(
			"session:setArchived",
			argumentsOf<[request: SetSessionArchivedRequest]>((args) => [
				schemas.setSessionArchivedRequestSchema.parse(args[0]),
			]),
			returns<SessionSummary[]>(),
		),
		setPinned: request(
			"session:setPinned",
			argumentsOf<[request: SetSessionPinnedRequest]>((args) => [schemas.setSessionPinnedRequestSchema.parse(args[0])]),
			returns<SessionSummary[]>(),
		),
		fork: request(
			"session:fork",
			argumentsOf<[request: ForkSessionRequest]>((args) => [schemas.forkSessionRequestSchema.parse(args[0])]),
			returns<SessionSummary>(),
		),
		retryTurn: request(
			"session:retryTurn",
			argumentsOf<[request: RewindSessionRequest]>((args) => [schemas.rewindSessionRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		rewindTo: request(
			"session:rewindTo",
			argumentsOf<[request: RewindSessionRequest]>((args) => [schemas.rewindSessionRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		rename: request(
			"session:rename",
			argumentsOf<[request: RenameSessionRequest]>((args) => [schemas.renameSessionRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		compact: request(
			"session:compact",
			argumentsOf<[request: CompactSessionRequest]>((args) => [schemas.compactSessionRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		pendingApprovalRequests: request("session:approval:pending", noArguments, returns<ApprovalRequest[]>()),
		respondToApproval: request(
			"session:approval:respond",
			argumentsOf<[requestId: string, approved: boolean]>((args) => {
				const parsed = schemas.approvalResponseSchema.parse({ requestId: args[0], approved: args[1] });
				return [parsed.requestId, parsed.approved];
			}),
			returns<void>(),
		),
		pendingExtensionUiRequests: request("session:extensionUi:pending", noArguments, returns<ExtensionUiRequest[]>()),
		respondToExtensionUi: request(
			"session:extensionUi:respond",
			argumentsOf<[requestId: string, value: string | null]>((args) => {
				const parsed = schemas.extensionUiResponseSchema.parse({ requestId: args[0], value: args[1] });
				return [parsed.requestId, parsed.value];
			}),
			returns<void>(),
		),
		sendExtensionUiInput: request(
			"session:extensionUi:input",
			argumentsOf<[request: ExtensionUiInputRequest]>((args) => [schemas.extensionUiInputRequestSchema.parse(args[0])]),
			returns<ExtensionTerminalInputResult>(),
		),
		dispatchExtensionTerminalInput: request(
			"session:extensionTerminalInput",
			argumentsOf<[request: ExtensionUiInputRequest]>((args) => [schemas.extensionUiInputRequestSchema.parse(args[0])]),
			returns<ExtensionTerminalInputResult>(),
		),
		updateExtensionUiViewport: request(
			"session:extensionUi:viewport",
			argumentsOf<[request: ExtensionUiViewportRequest]>((args) => [
				schemas.extensionUiViewportRequestSchema.parse(args[0]),
			]),
			returns<void>(),
		),
		setExtensionUiEditorText: request(
			"session:extensionUi:editorText",
			argumentsOf<[request: ExtensionUiEditorTextRequest]>((args) => [
				schemas.extensionUiEditorTextRequestSchema.parse(args[0]),
			]),
			returns<void>(),
		),
		getExtensionAutocomplete: request(
			"session:extensionAutocomplete",
			argumentsOf<[request: ExtensionAutocompleteRequest]>((args) => [
				schemas.extensionAutocompleteRequestSchema.parse(args[0]),
			]),
			returns<ExtensionAutocompleteSuggestions | null>(),
		),
		applyExtensionAutocomplete: request(
			"session:extensionAutocomplete:apply",
			argumentsOf<[request: ApplyExtensionAutocompleteRequest]>((args) => [
				schemas.applyExtensionAutocompleteRequestSchema.parse(args[0]),
			]),
			returns<ApplyExtensionAutocompleteResult>(),
		),
		onExtensionUiRequest: event("session:extension-ui-request", returns<ExtensionUiRequest>()),
		onExtensionUiDismiss: event("session:extension-ui-dismiss", returns<DialogDismissEvent>()),
		onEvent: event("session:event", returns<SessionEventEnvelope>()),
		onRuntimeSuspended: event("session:runtime-suspended", returns<SessionRuntimeSuspendedEvent>()),
		onApprovalRequest: event("session:approval-request", returns<ApprovalRequest>()),
		onApprovalDismiss: event("session:approval-dismiss", returns<DialogDismissEvent>()),
		onTitleChanged: event("session:title-changed", returns<SessionTitleChangedEvent>()),
		onCatalogChanged: event("session:catalog-changed", returns<SessionCatalogChange>()),
		onActivateRequest: event("session:activateRequest", returns<SessionRef>()),
	};
}
export const sessionProcedures = createSessionProcedures();
