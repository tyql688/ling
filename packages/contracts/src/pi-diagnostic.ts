export type PiDiagnosticSeverity = "info" | "warning" | "error";

export type PiDiagnosticCode =
	| "PI_SERVICE_DIAGNOSTIC"
	| "PI_EXTENSION_LOAD_FAILED"
	| "PI_SKILL_DIAGNOSTIC"
	| "PI_PROMPT_DIAGNOSTIC"
	| "PI_THEME_DIAGNOSTIC"
	| "PI_SESSION_SCHEMA_NEWER"
	| "PI_DIAGNOSTIC_UNKNOWN";

export type PiDiagnosticSource =
	"pi.services" | "pi.extension" | "pi.skill" | "pi.prompt" | "pi.theme" | "pi.session" | "pi.unknown";

type PiDiagnosticDetail = null | boolean | number | string;

/** Stable, serializable diagnostic projection. Pi may change its internal diagnostic
 * objects; only this bounded contract crosses into Ling application/Renderer owners. */
export interface PiDiagnostic {
	protocolVersion: 1;
	code: PiDiagnosticCode;
	severity: PiDiagnosticSeverity;
	source: PiDiagnosticSource;
	message: string;
	path?: string;
	details: Readonly<Record<string, PiDiagnosticDetail>>;
}
