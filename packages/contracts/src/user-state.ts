import { z } from "zod";
import { INTERFACE_ZOOM_PERCENTS, UI_LANGUAGES } from "./application";
import { skinArtworkScopeSchema, skinArtworkTreatmentSchema } from "./skins";
import { sessionKey, sessionRefSchema, type SessionRef } from "./session-ref";
import { portableAbsolutePathSchema } from "./path-validation";

/** Recent read markers are a convenience cache, not the durable session catalog. */
export const SESSION_SEEN_MAX_ITEMS = 10_000;
/** The ordered strip keeps the latest pinned tabs; previews belong to each window. */
export const OPEN_SESSION_TABS_MAX_ITEMS = 40;
/** Match the existing project preference and reviewed-progress retention budgets. */
export const USER_PROJECT_MAX_ITEMS = 10_000;
export const REVIEWED_SESSION_MAX_ITEMS = 64;
const REVIEWED_MAP_MAX_CHARS = 256 * 1024;
/** Bound the complete shared snapshot, including keys, independently of each reviewed session. */
const REVIEWED_TOTAL_MAX_CHARS = 4 * 1024 * 1024;
const cwdSchema = portableAbsolutePathSchema("Project path");
// Legacy read markers accepted finite timestamps, including fractional and pre-epoch values.
const timestampSchema = z.number();
export const openSessionTabsSchema = z.array(sessionRefSchema).max(OPEN_SESSION_TABS_MAX_ITEMS);
const reviewedMarkSchema = z.strictObject({
	status: z.string().max(REVIEWED_MAP_MAX_CHARS),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	contentTag: z.string().max(REVIEWED_MAP_MAX_CHARS).nullable(),
});
export type ReviewedMark = z.infer<typeof reviewedMarkSchema>;
export type ReviewedMap = Record<string, ReviewedMark>;
export const reviewedMapSchema = z
	.custom<Record<string, unknown>>(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Reviewed progress must be a path map",
	)
	.transform((value) => Object.entries(value))
	.pipe(z.array(z.tuple([z.string().max(8192), reviewedMarkSchema])))
	.transform((entries) => Object.fromEntries(entries))
	.refine(
		(value) => JSON.stringify(value).length <= REVIEWED_MAP_MAX_CHARS,
		"Reviewed progress exceeds its retained budget",
	);
export const skinPreferenceSchema = z
	.string()
	.regex(/^(default|(?:builtin|custom):[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/);
export const skinSceneOverrideSchema = z.strictObject({
	scope: skinArtworkScopeSchema.optional(),
	treatment: skinArtworkTreatmentSchema.optional(),
});
export type SkinSceneOverride = z.infer<typeof skinSceneOverrideSchema>;
export const skinSceneOverridesSchema = z
	.record(skinPreferenceSchema, skinSceneOverrideSchema)
	.refine((value) => JSON.stringify(value).length <= 32 * 1024, "Skin scene choices exceed their storage budget");
const interfaceZoomChoiceSchema = z.enum(INTERFACE_ZOOM_PERCENTS.map((value) => String(value) as `${typeof value}`));
export const sharedPreferenceSchema = z.discriminatedUnion("key", [
	// Bound the CSS family list and glyph geometry retained by each terminal emulator.
	z.strictObject({ key: z.literal("terminalFontFamily"), value: z.string().max(200) }),
	z.strictObject({ key: z.literal("terminalFontSize"), value: z.number().int().min(12).max(22) }),
	z.strictObject({ key: z.literal("composerEditorMode"), value: z.enum(["plain", "markdown"]) }),
	z.strictObject({
		key: z.literal("sendShortcut"),
		value: z.enum(["enter", "cmd-enter-multiline", "cmd-enter-always"]),
	}),
	z.strictObject({ key: z.literal("followUpBehavior"), value: z.enum(["queue", "steer"]) }),
	z.strictObject({ key: z.literal("showTodayUsage"), value: z.boolean() }),
	z.strictObject({ key: z.literal("theme"), value: z.enum(["system", "light", "dark"]) }),
	z.strictObject({ key: z.literal("skin"), value: skinPreferenceSchema }),
	z.strictObject({ key: z.literal("skinExpression"), value: z.enum(["balanced", "immersive"]) }),
	z.strictObject({ key: z.literal("language"), value: z.enum(UI_LANGUAGES) }),
	z.strictObject({ key: z.literal("interfaceZoom"), value: interfaceZoomChoiceSchema }),
	z.strictObject({ key: z.literal("fontSmoothing"), value: z.enum(["automatic", "antialiased", "system"]) }),
	z.strictObject({ key: z.literal("nativeTransparency"), value: z.number().int().min(0).max(100) }),
]);
export type SharedPreference = z.infer<typeof sharedPreferenceSchema>;
type SharedPreferences = { [Key in SharedPreference["key"]]?: Extract<SharedPreference, { key: Key }>["value"] };
export const userStateMutationSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("projectPin"), cwd: cwdSchema, pinned: z.boolean() }),
	z.strictObject({
		type: z.literal("projectName"),
		cwd: cwdSchema,
		name: z
			.string()
			.min(1)
			.max(1024 * 1024)
			.nullable(),
	}),
	z.strictObject({ type: z.literal("sessionSeen"), ref: sessionRefSchema, seenAt: timestampSchema }),
	z.strictObject({
		type: z.literal("tabs"),
		add: z.array(sessionRefSchema).max(OPEN_SESSION_TABS_MAX_ITEMS),
		remove: z.array(sessionRefSchema).max(OPEN_SESSION_TABS_MAX_ITEMS),
		// Older clients omit order. Reordering changes existing tabs only; it never reopens a closed session.
		order: openSessionTabsSchema.optional(),
	}),
	z.strictObject({ type: z.literal("lastProject"), cwd: cwdSchema.nullable() }),
	z.strictObject({ type: z.literal("sidebarScope"), cwd: cwdSchema.nullable() }),
	z.strictObject({
		type: z.literal("reviewMark"),
		ref: sessionRefSchema,
		path: z.string().min(1).max(8192),
		mark: reviewedMarkSchema.nullable(),
	}),
	z.strictObject({ type: z.literal("preference"), preference: sharedPreferenceSchema }),
	z.strictObject({
		type: z.literal("skinScene"),
		key: skinPreferenceSchema,
		scene: skinSceneOverrideSchema.nullable(),
	}),
]);
export type UserStateMutation = z.infer<typeof userStateMutationSchema>;
export interface UserState {
	pinnedProjectCwds: string[];
	projectDisplayNames: Record<string, string>;
	sessionSeenAt: Record<string, number>;
	openSessionTabs: SessionRef[];
	lastConversationCwd: string | null;
	sidebarProjectScope: string | null;
	reviewed: Record<string, ReviewedMap>;
	preferences: SharedPreferences;
	skinScenes: z.infer<typeof skinSceneOverridesSchema>;
}
export interface UserStateSnapshot {
	revision: number;
	state: UserState;
	issues: { key: string; message: string }[];
}
export interface UserStateChange {
	revision: number;
	mutations: UserStateMutation[] | null;
}
export function emptyUserState(): UserState {
	return {
		pinnedProjectCwds: [],
		projectDisplayNames: {},
		sessionSeenAt: {},
		openSessionTabs: [],
		lastConversationCwd: null,
		sidebarProjectScope: null,
		reviewed: {},
		preferences: {},
		skinScenes: {},
	};
}
/** Shared operations merge independent edits; a tab close or renamed project cannot replace another client's whole map. */
export function applyUserStateMutation(state: UserState, mutation: UserStateMutation): UserState {
	switch (mutation.type) {
		case "projectPin": {
			const existing = state.pinnedProjectCwds.includes(mutation.cwd);
			if (existing === mutation.pinned) return state;
			return {
				...state,
				pinnedProjectCwds: mutation.pinned
					? [mutation.cwd, ...state.pinnedProjectCwds]
					: state.pinnedProjectCwds.filter((cwd) => cwd !== mutation.cwd),
			};
		}
		case "projectName": {
			const names = { ...state.projectDisplayNames };
			if (mutation.name === null) delete names[mutation.cwd];
			else names[mutation.cwd] = mutation.name;
			return { ...state, projectDisplayNames: names };
		}
		case "sessionSeen": {
			const key = sessionKey(mutation.ref),
				previous = state.sessionSeenAt[key];
			if (previous !== undefined && previous >= mutation.seenAt) return state;
			const entries = Object.entries({ ...state.sessionSeenAt, [key]: mutation.seenAt });
			if (entries.length > SESSION_SEEN_MAX_ITEMS) entries.sort((a, b) => b[1] - a[1]).splice(SESSION_SEEN_MAX_ITEMS);
			return { ...state, sessionSeenAt: Object.fromEntries(entries) };
		}
		case "tabs": {
			const removed = new Set(mutation.remove.map(sessionKey));
			const tabs = new Map(
				state.openSessionTabs.filter((ref) => !removed.has(sessionKey(ref))).map((ref) => [sessionKey(ref), ref]),
			);
			for (const ref of mutation.add) if (!tabs.has(sessionKey(ref))) tabs.set(sessionKey(ref), ref);
			const ordered = (mutation.order ?? []).filter((ref) => tabs.has(sessionKey(ref)));
			const positions = new Map(ordered.map((ref, index) => [sessionKey(ref), index]));
			const reordered = [...tabs.values()].filter((ref) => positions.has(sessionKey(ref)));
			reordered.sort((a, b) => positions.get(sessionKey(a))! - positions.get(sessionKey(b))!);
			let index = 0;
			return {
				...state,
				openSessionTabs: [...tabs.values()]
					.map((ref) => (positions.has(sessionKey(ref)) ? reordered[index++]! : ref))
					.slice(-OPEN_SESSION_TABS_MAX_ITEMS),
			};
		}
		case "lastProject":
			return { ...state, lastConversationCwd: mutation.cwd };
		case "sidebarScope":
			return { ...state, sidebarProjectScope: mutation.cwd };
		case "reviewMark": {
			const key = sessionKey(mutation.ref),
				marks = { ...state.reviewed[key] };
			if (mutation.mark === null) delete marks[mutation.path];
			else Object.defineProperty(marks, mutation.path, { value: mutation.mark, enumerable: true, configurable: true });
			const reviewed = { ...state.reviewed };
			delete reviewed[key];
			if (Object.keys(marks).length > 0) reviewed[key] = marks;
			return { ...state, reviewed: retainReviewedProgress(reviewed) };
		}
		case "skinScene": {
			const skinScenes = { ...state.skinScenes };
			if (mutation.scene === null) delete skinScenes[mutation.key];
			else skinScenes[mutation.key] = mutation.scene;
			return { ...state, skinScenes };
		}
		case "preference":
			return { ...state, preferences: { ...state.preferences, [mutation.preference.key]: mutation.preference.value } };
	}
}
/** The import identifier is content-addressed so retrying the same legacy source is idempotent. */
export const userStateImportSchema = z.strictObject({
	source: z.string().min(1).max(16384),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	mutations: z.array(userStateMutationSchema).max(10_000),
});
export type UserStateImport = z.infer<typeof userStateImportSchema>;
export const userStateUpdateSchema = z.array(userStateMutationSchema).min(1).max(256);

/** Object insertion order records least-to-most recent use of this disposable progress cache. */
export function retainReviewedProgress(reviewed: UserState["reviewed"]): UserState["reviewed"] {
	const entries = Object.entries(reviewed);
	let chars = 2;
	const retained: typeof entries = [];
	for (const entry of entries.reverse()) {
		const size = JSON.stringify(entry[0]).length + JSON.stringify(entry[1]).length + 2;
		if (retained.length >= REVIEWED_SESSION_MAX_ITEMS || chars + size > REVIEWED_TOTAL_MAX_CHARS) break;
		retained.push(entry);
		chars += size;
	}
	return Object.fromEntries(retained.reverse());
}

/** Only unacknowledged changes are held in the renderer recovery journal. */
export const userStateRecoverySchema = z.strictObject({
	version: z.literal(1),
	mutations: z.array(userStateMutationSchema).max(10_000),
});

/** A first-paint hint only; these choices become authoritative after the Host snapshot arrives. */
export const uiBootPreferencesSchema = z.strictObject({
	version: z.literal(1),
	theme: z.enum(["system", "light", "dark"]),
	skin: skinPreferenceSchema,
	skinExpression: z.enum(["balanced", "immersive"]),
	nativeTransparency: z.number().int().min(0).max(100),
	fontSmoothing: z.enum(["automatic", "antialiased", "system"]),
	interfaceZoom: interfaceZoomChoiceSchema,
	language: z.enum(UI_LANGUAGES).optional(),
});

/** Bound retained unacknowledged renderer operations before serializing the recovery journal. */
export const USER_STATE_RECOVERY_MAX_CHARS = 2 * 1024 * 1024;
