import { z } from "zod";
import { portableAbsolutePathSchema } from "./path-validation";
import { sessionRefSchema, type SessionRef } from "./session-ref";
import { boundedString, nonEmptyBoundedString, safeIdSchema } from "./schema-primitives";

export interface ProjectRef {
	cwd: string;
}

type OwnerScopeRef =
	{ kind: "app" } | { kind: "global" } | { kind: "project"; ref: ProjectRef } | { kind: "session"; ref: SessionRef };

type OwnerKind = "ling" | "piPackage" | "mcp" | "externalCapability";

interface OwnerRef {
	kind: OwnerKind;
	id: string;
	source: string;
	scope: OwnerScopeRef;
	version?: string;
	revision: string | null;
	generation: number;
}

export interface OperationRef {
	requestId: string;
	owner: OwnerRef;
}

/** Identifies a built-in Ling operation. */
const BUILTIN_SOURCE = "ling:built-in";

/** Main and renderer use the same built-in operation ids. isBuiltinOperationRef compares these strings at runtime and rejects mismatches as a different owner. */
export const SESSION_TRANSCRIPT_OWNER_ID = "session.transcript";
export const SESSION_AUTOCOMPLETE_OWNER_ID = "session.autocomplete";
export const SESSION_COMMAND_ARGUMENT_COMPLETION_OWNER_ID = "session.commandArgumentCompletion";
export const CHANGE_REVIEW_DIFF_OWNER_ID = "changeReview.diff";

interface BuiltinOperationBinding {
	scope: OwnerScopeRef;
	revision: string | null;
	generation: number;
}

function encode(value: string): string {
	return `${value.length}:${value}`;
}

function projectKey(ref: ProjectRef): string {
	return encode(ref.cwd);
}

function ownerScopeKey(scope: OwnerScopeRef): string {
	switch (scope.kind) {
		case "app":
		case "global":
			return scope.kind;
		case "project":
			return `project:${projectKey(scope.ref)}`;
		case "session":
			return `session:${projectKey(scope.ref)}:${encode(scope.ref.sessionId)}`;
	}
}

function ownerKey(owner: OwnerRef): string {
	return [
		owner.kind,
		encode(owner.source),
		encode(owner.id),
		ownerScopeKey(owner.scope),
		owner.version === undefined ? "version:-" : `version:${encode(owner.version)}`,
		owner.revision === null ? "revision:-" : `revision:${encode(owner.revision)}`,
		`generation:${owner.generation}`,
	].join("|");
}

function operationKey(operation: OperationRef): string {
	return `${ownerKey(operation.owner)}|request:${encode(operation.requestId)}`;
}

export function sameOperationRef(left: OperationRef, right: OperationRef): boolean {
	return operationKey(left) === operationKey(right);
}

export function createBuiltinOperationRef(
	requestId: string,
	ownerId: string,
	binding: BuiltinOperationBinding,
): OperationRef {
	return {
		requestId,
		owner: {
			kind: "ling",
			id: ownerId,
			source: BUILTIN_SOURCE,
			scope: binding.scope,
			revision: binding.revision,
			generation: binding.generation,
		},
	};
}

export function isBuiltinOperationRef(
	operation: OperationRef,
	ownerId: string,
	binding: BuiltinOperationBinding,
): boolean {
	return sameOperationRef(operation, createBuiltinOperationRef(operation.requestId, ownerId, binding));
}

/** Binds built-in session work to its runtime generation. A replacement runtime can cancel or complete work created in its own generation. */
export function createBuiltinSessionOperationRef(
	requestId: string,
	ownerId: string,
	ref: SessionRef,
	generation: number,
): OperationRef {
	return createBuiltinOperationRef(requestId, ownerId, {
		scope: { kind: "session", ref: { ...ref } },
		revision: null,
		generation,
	});
}

export function isBuiltinSessionOperationRef(
	operation: OperationRef,
	ownerId: string,
	ref: SessionRef,
	generation: number,
): boolean {
	return sameOperationRef(operation, createBuiltinSessionOperationRef(operation.requestId, ownerId, ref, generation));
}

/** Caps OwnerRef.id for package and skill identifiers. */
const MAX_OWNER_ID_LENGTH = 512;
/** Caps OwnerRef.source at 2 Ki characters for paths or npm specifiers. */
const MAX_OWNER_SOURCE_LENGTH = 2_048;
/** Caps OwnerRef.version at 512 characters for versions or hashes. */
const MAX_OWNER_VERSION_LENGTH = 512;
/** Caps OwnerRef.revision at 2 Ki characters for content hashes or generation ids. */
const MAX_OWNER_REVISION_LENGTH = 2_048;

/** Operation request identifiers are short UUIDs; reject unbounded correlation keys. */
const OPERATION_REQUEST_ID_MAX_CHARS = 128;
const cwdSchema = portableAbsolutePathSchema("Project path");

const projectRefSchema: z.ZodType<ProjectRef> = z.strictObject({ cwd: cwdSchema });
const ownerScopeRefSchema: z.ZodType<OwnerScopeRef> = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("app") }),
	z.strictObject({ kind: z.literal("global") }),
	z.strictObject({ kind: z.literal("project"), ref: projectRefSchema }),
	z.strictObject({ kind: z.literal("session"), ref: sessionRefSchema }),
]);
const ownerRefSchema: z.ZodType<OwnerRef> = z
	.strictObject({
		kind: z.enum(["ling", "piPackage", "mcp", "externalCapability"]),
		id: safeIdSchema(MAX_OWNER_ID_LENGTH, "Owner id"),
		source: nonEmptyBoundedString(MAX_OWNER_SOURCE_LENGTH, "Owner source"),
		scope: ownerScopeRefSchema,
		version: nonEmptyBoundedString(MAX_OWNER_VERSION_LENGTH, "Owner version").optional(),
		revision: boundedString(MAX_OWNER_REVISION_LENGTH, "Owner revision").nullable(),
		generation: z.number().int().nonnegative(),
	})
	.transform(({ version, ...owner }): OwnerRef => ({
		...owner,
		...(version !== undefined ? { version } : {}),
	}));
export const operationRefSchema: z.ZodType<OperationRef> = z.strictObject({
	requestId: safeIdSchema(OPERATION_REQUEST_ID_MAX_CHARS, "Operation request id"),
	owner: ownerRefSchema,
});
