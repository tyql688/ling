import {
	reviewedMapSchema,
	skinSceneOverridesSchema,
	userStateMutationSchema,
	type UserStateMutation,
} from "./user-state";
import { parseSessionKey } from "./session-ref";
import { z } from "zod";

export const LEGACY_REVIEWED_PREFIX = "ling:change-review-reviewed:";
export const LEGACY_USER_STATE_KEYS = [
	"ling:pinned-project-cwds",
	"ling:project-display-names",
	"ling:session-seen-at",
	"ling:open-session-tabs",
	"ling:last-conversation-cwd",
	"ling:sidebar-project-scope",
	"ling:composer-editor-mode",
	"ling:send-shortcut",
	"ling:follow-up-behavior",
	"ling:show-today-usage",
	"ling:theme",
	"ling:skin",
	"ling:skin-expression",
	"ling:skin-scene-overrides",
	"ling:language",
	"ling:interface-zoom",
	"ling:font-smoothing",
	"ling:vibrancy-transparency",
];
const preferences: Record<string, string> = {
	"ling:composer-editor-mode": "composerEditorMode",
	"ling:send-shortcut": "sendShortcut",
	"ling:follow-up-behavior": "followUpBehavior",
	"ling:show-today-usage": "showTodayUsage",
	"ling:theme": "theme",
	"ling:skin": "skin",
	"ling:skin-expression": "skinExpression",
	"ling:language": "language",
	"ling:interface-zoom": "interfaceZoom",
	"ling:font-smoothing": "fontSmoothing",
	"ling:vibrancy-transparency": "nativeTransparency",
};
/** Historical records can contain a damaged entity alongside valid ones. Keep that distinction for source acknowledgement. */
export function parseLegacyUserState(key: string, raw: string) {
	const mutations: UserStateMutation[] = [];
	const issues: string[] = [];
	function accept(value: unknown) {
		const parsed = userStateMutationSchema.safeParse(value);
		if (parsed.success) mutations.push(parsed.data);
		else issues.push(parsed.error.message);
	}
	// Browser storage bounds these keys at 2 MiB. Reject an oversized source without replacing its bytes.
	if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024)
		throw new Error("Legacy user state exceeds its storage budget");
	const preference = preferences[key];
	if (preference) {
		accept({
			type: "preference",
			preference: {
				key: preference,
				value: ["showTodayUsage", "nativeTransparency"].includes(preference) ? JSON.parse(raw) : raw,
			},
		});
		return { mutations, issues };
	}
	const value: unknown = JSON.parse(raw);
	switch (key) {
		case "ling:skin-scene-overrides":
			for (const [key, scene] of Object.entries(skinSceneOverridesSchema.parse(value)))
				accept({ type: "skinScene", key, scene });
			break;
		case "ling:pinned-project-cwds":
			// Pin operations prepend, whereas the legacy array already starts with the newest pin.
			for (const cwd of z.array(z.unknown()).parse(value).reverse()) accept({ type: "projectPin", cwd, pinned: true });
			break;
		case "ling:project-display-names":
			for (const [cwd, name] of Object.entries(z.record(z.string(), z.unknown()).parse(value)))
				accept({ type: "projectName", cwd, name });
			break;
		case "ling:session-seen-at":
			for (const [key, seenAt] of Object.entries(z.record(z.string(), z.unknown()).parse(value)))
				accept({ type: "sessionSeen", ref: parseSessionKey(key), seenAt });
			break;
		case "ling:open-session-tabs": {
			const refs = z.array(z.unknown()).parse(value);
			// The legacy owner kept only the latest forty tabs.
			const parsed = userStateMutationSchema.safeParse({ type: "tabs", add: refs.slice(-40), remove: [] });
			if (parsed.success) mutations.push(parsed.data);
			else issues.push(parsed.error.message);
			break;
		}
		case "ling:last-conversation-cwd":
			accept({ type: "lastProject", cwd: value });
			break;
		case "ling:sidebar-project-scope":
			accept({ type: "sidebarScope", cwd: value });
			break;
		default: {
			if (!key.startsWith(LEGACY_REVIEWED_PREFIX)) throw new Error("Unknown legacy user state source");
			const ref = parseSessionKey(key.slice(LEGACY_REVIEWED_PREFIX.length));
			const map = reviewedMapSchema.parse(value);
			for (const [path, mark] of Object.entries(map)) accept({ type: "reviewMark", ref, path, mark });
		}
	}
	if (mutations.length > 10_000) throw new Error("Legacy user state exceeds its entry budget");
	return { mutations, issues };
}
