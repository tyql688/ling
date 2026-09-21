/** Safe for diagnostics: embedded proxy credentials are never returned. */
export function redactProxyUrl(proxy: string): string {
	try {
		const parsed = new URL(proxy);
		if (parsed.username || parsed.password) {
			parsed.username = "redacted";
			parsed.password = "redacted";
		}
		return parsed.toString();
	} catch {
		return "[invalid proxy URL]";
	}
}
