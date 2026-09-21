import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import type {
	PiDiagnostic,
	PiDiagnosticCode,
	PiDiagnosticSeverity,
	PiDiagnosticSource,
} from "@ling/contracts/pi-diagnostic";
import { record } from "@ling/contracts/records";
import type { PiAgentSessionServices } from "./types";

/** Diagnostic message truncation limit (16Ki); keeps enough stack/error text while stopping oversized SDK text from bloating IPC. */
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 16_384;

interface DiagnosticDescriptor {
	code: PiDiagnosticCode;
	source: PiDiagnosticSource;
	context: string;
	fixedSeverity?: PiDiagnosticSeverity;
}

class PiDiagnosticsError extends Error {
	readonly diagnostics: PiDiagnostic[];

	constructor(context: string, diagnostics: readonly PiDiagnostic[]) {
		const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		const message = errors.length > 0 ? errors.map(formatDiagnostic).join("; ") : "Pi diagnostics failed";
		super(`${context}: ${message}`);
		this.name = "PiDiagnosticsError";
		this.diagnostics = [...diagnostics];
	}
}

function formatDiagnostic(diagnostic: PiDiagnostic): string {
	const path = diagnostic.path ? `${diagnostic.path}: ` : "";
	return `${diagnostic.code} ${path}${diagnostic.message}`;
}

function severity(value: unknown): PiDiagnosticSeverity | null {
	// Pi reports same-name resources in two roots as `collision`; the first root wins and
	// shadowing is how a user overrides a built-in, so it is information, not a warning.
	if (value === "collision") return "info";
	return value === "info" || value === "warning" || value === "error" ? value : null;
}

function boundedText(value: unknown, maxLength: number): { text: string; truncated: boolean } | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return value.length <= maxLength
		? { text: value, truncated: false }
		: { text: value.slice(0, maxLength), truncated: true };
}

function unknownDiagnostic(context: string, reason: string): PiDiagnostic {
	return {
		protocolVersion: 1,
		code: "PI_DIAGNOSTIC_UNKNOWN",
		severity: "error",
		source: "pi.unknown",
		message: `Pi returned an invalid ${context} diagnostic.`,
		details: { context, reason },
	};
}

function normalizePiDiagnostic(value: unknown, descriptor: DiagnosticDescriptor): PiDiagnostic {
	const source = record(value);
	if (!source) return unknownDiagnostic(descriptor.context, "notObject");
	const message = boundedText(source.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
	if (!message) return unknownDiagnostic(descriptor.context, "invalidMessage");
	const normalizedSeverity = descriptor.fixedSeverity ?? severity(source.type);
	if (!normalizedSeverity) return unknownDiagnostic(descriptor.context, "invalidSeverity");
	const path = source.path === undefined ? null : boundedText(source.path, ABSOLUTE_PATH_MAX_CHARS);
	if (source.path !== undefined && !path) return unknownDiagnostic(descriptor.context, "invalidPath");
	const details: Record<string, null | boolean | number | string> = { context: descriptor.context };
	if (message.truncated) details.messageTruncated = true;
	if (path?.truncated) details.pathTruncated = true;
	if (path) details.path = path.text;
	return {
		protocolVersion: 1,
		code: descriptor.code,
		severity: normalizedSeverity,
		source: descriptor.source,
		message: message.text,
		...(path ? { path: path.text } : {}),
		details,
	};
}

export function assertNoBlockingDiagnostics(context: string, diagnostics: readonly PiDiagnostic[]): void {
	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		throw new PiDiagnosticsError(context, diagnostics);
	}
}

export function collectServiceDiagnostics(services: PiAgentSessionServices): PiDiagnostic[] {
	const diagnostics: PiDiagnostic[] = services.diagnostics.map((diagnostic) =>
		normalizePiDiagnostic(diagnostic, {
			code: "PI_SERVICE_DIAGNOSTIC",
			source: "pi.services",
			context: "service",
		}),
	);

	const extensions = services.resourceLoader.getExtensions();
	for (const error of extensions.errors) {
		diagnostics.push(
			normalizePiDiagnostic(
				{ type: "error", message: error.error, path: error.path },
				{
					code: "PI_EXTENSION_LOAD_FAILED",
					source: "pi.extension",
					context: "extension",
					fixedSeverity: "error",
				},
			),
		);
	}

	for (const diagnostic of services.resourceLoader.getSkills().diagnostics) {
		diagnostics.push(
			normalizePiDiagnostic(diagnostic, {
				code: "PI_SKILL_DIAGNOSTIC",
				source: "pi.skill",
				context: "skill",
			}),
		);
	}
	for (const diagnostic of services.resourceLoader.getPrompts().diagnostics) {
		diagnostics.push(
			normalizePiDiagnostic(diagnostic, {
				code: "PI_PROMPT_DIAGNOSTIC",
				source: "pi.prompt",
				context: "prompt",
			}),
		);
	}
	for (const diagnostic of services.resourceLoader.getThemes().diagnostics) {
		diagnostics.push(
			normalizePiDiagnostic(diagnostic, {
				code: "PI_THEME_DIAGNOSTIC",
				source: "pi.theme",
				context: "theme",
			}),
		);
	}

	return diagnostics;
}
