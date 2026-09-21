import type { SessionRef } from "@ling/contracts/session";
import { isAbsolute } from "node:path";

const APP_URL_SCHEME = "ling";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseAppUrl(value: string): SessionRef | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== `${APP_URL_SCHEME}:` || url.host !== "session") return null;
	const cwd = url.searchParams.get("cwd");
	const sessionId = url.searchParams.get("id");
	if (!cwd || !sessionId || !isAbsolute(cwd) || cwd.includes("\0") || !SESSION_ID_PATTERN.test(sessionId)) {
		return null;
	}
	return { cwd, sessionId };
}
