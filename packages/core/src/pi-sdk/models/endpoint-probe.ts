/**
 * Pre-save connectivity probe for custom OpenAI-compatible endpoints: surfaces failures at
 * configuration time instead of "first conversation". Advisory only — never a save gate.
 */

type EndpointProbeResult =
	| { ok: true; modelCount: number | null }
	| { ok: false; reason: "unreachable" | "timeout" | "auth" | "http"; status?: number };

/** Pre-save connectivity-probe timeout. 10s covers slow networks; longer stalls the settings form and shorter misreports as unreachable. */
const PROBE_TIMEOUT_MS = 10_000;
/** The probe only needs the top-level model list; never retain an arbitrary response body. */
const PROBE_RESPONSE_MAX_BYTES = 2 * 1_024 * 1_024;
/** Byte budget alone still permits millions of tiny stream chunks and string slots. */
const PROBE_RESPONSE_MAX_CHUNKS = 4_096;

function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export async function probeOpenAiCompatibleEndpoint(
	baseUrl: string,
	apiKey: string | null,
): Promise<EndpointProbeResult> {
	// AbortSignal.timeout needs no clearTimeout and names its own abort reason TimeoutError.
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(modelsUrl(baseUrl), {
			headers: {
				Accept: "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			signal,
		});
	} catch (error) {
		return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable" };
	}

	if (response.status === 401 || response.status === 403) {
		void response.body?.cancel().catch(() => undefined);
		return { ok: false, reason: "auth", status: response.status };
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined);
		return { ok: false, reason: "http", status: response.status };
	}

	try {
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > PROBE_RESPONSE_MAX_BYTES) {
			void response.body?.cancel().catch(() => undefined);
			return { ok: true, modelCount: null };
		}
		if (!response.body) return { ok: true, modelCount: null };
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const parts: string[] = [];
		let totalBytes = 0;
		let chunkCount = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				if (chunk.value.byteLength === 0) continue;
				chunkCount += 1;
				totalBytes += chunk.value.byteLength;
				if (totalBytes > PROBE_RESPONSE_MAX_BYTES || chunkCount > PROBE_RESPONSE_MAX_CHUNKS) {
					void reader.cancel().catch(() => undefined);
					return { ok: true, modelCount: null };
				}
				parts.push(decoder.decode(chunk.value, { stream: true }));
			}
			parts.push(decoder.decode());
		} finally {
			reader.releaseLock();
		}
		const body: unknown = JSON.parse(parts.join(""));
		const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
		return { ok: true, modelCount: Array.isArray(data) ? data.length : null };
	} catch (error) {
		if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
			return { ok: false, reason: "timeout" };
		}
		// 200 with a non-JSON body still proves the endpoint answered; the count is unknown.
		return { ok: true, modelCount: null };
	}
}
