import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ProviderQuota,
	ProviderQuotaAmount,
	ProviderQuotaErrorCode,
	ProviderQuotaWindow,
	ProviderQuotaWindowKind,
} from "@ling/contracts/usage";
import { throwIfOperationAborted, toError, waitForOperation } from "@ling/core/ling-error";
import { createHash } from "node:crypto";
import { z } from "zod";

/** Account endpoints should fail before the outer Pi-worker request deadline. */
const PROVIDER_QUOTA_TIMEOUT_MS = 12_000;
/** Quota responses are small account summaries; 512 KiB rejects accidental or hostile bulk payloads. */
const PROVIDER_QUOTA_RESPONSE_MAX_BYTES = 512 * 1_024;
/** A chunk cap prevents a peer from exhausting memory with an extreme number of empty fragments. */
const PROVIDER_QUOTA_RESPONSE_MAX_CHUNKS = 2_048;
/** Provider labels and plan names stay bounded before crossing the Pi-worker protocol. */
const PROVIDER_QUOTA_TEXT_MAX_CHARS = 256;
/** Provider payload timestamps never need more than one short ISO-8601 value. */
export const PROVIDER_QUOTA_DATE_MAX_CHARS = 64;
/** Provider accounts expose at most a small set of quota lanes; larger arrays are treated as schema drift. */
export const PROVIDER_QUOTA_WINDOW_MAX_ITEMS = 64;
/** Values below this contemporary-epoch threshold are seconds rather than milliseconds. */
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
/** Converts provider epoch seconds into the millisecond timestamps used by Ling contracts. */
export const MILLISECONDS_PER_SECOND = 1_000;
/** One minute in seconds, used to preserve provider-reported window durations. */
export const SECONDS_PER_MINUTE = 60;
/** One hour in seconds, used for named rolling windows. */
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
/** One day in seconds, used for named weekly windows. */
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
/** One week in seconds, used for provider weekly quotas. */
export const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
/** Currency APIs report minor units in hundredths of the named currency. */
export const MINOR_UNITS_PER_CURRENCY_UNIT = 100;

export const textSchema = z.string().trim().min(1).max(PROVIDER_QUOTA_TEXT_MAX_CHARS);
export const dateSchema = z
	.string()
	.trim()
	.min(1)
	.max(PROVIDER_QUOTA_DATE_MAX_CHARS)
	.refine((value) => epochMilliseconds(value) !== null);
export const finiteNumberSchema = z.number();
export const nonnegativeNumberSchema = finiteNumberSchema.nonnegative();
export const flexibleNumberSchema = z
	.union([finiteNumberSchema, z.string().trim().min(1).max(PROVIDER_QUOTA_DATE_MAX_CHARS)])
	.transform(Number)
	.pipe(finiteNumberSchema);
export const flexibleNonnegativeNumberSchema = flexibleNumberSchema.pipe(nonnegativeNumberSchema);
export const flexibleNonnegativeIntegerSchema = flexibleNumberSchema.pipe(z.number().int().nonnegative());

export interface ProviderQuotaData {
	plan: string | null;
	windows: ProviderQuotaWindow[];
	amounts: ProviderQuotaAmount[];
}

export type RuntimeProvider = Pick<ReturnType<ModelRuntime["getProviders"]>[number], "id" | "name" | "baseUrl">;
export type QuotaRuntime = Pick<ModelRuntime, "getAuth" | "getModels" | "isUsingOAuth">;
type ResolvedProviderAuth = NonNullable<Awaited<ReturnType<ModelRuntime["getAuth"]>>>;

/** Compare exact allowlisted endpoints; URL normalization must not admit custom credential destinations. */
export function canonicalQuotaProvider(
	runtime: QuotaRuntime,
	provider: RuntimeProvider,
	baseUrls: readonly string[],
	source: "provider" | "models",
): boolean {
	const urls = source === "models" ? runtime.getModels(provider.id).map((model) => model.baseUrl) : [provider.baseUrl];
	return urls.length > 0 && urls.every((url) => url !== undefined && baseUrls.includes(url.replace(/\/+$/u, "")));
}

export function providerQuotaResult(
	provider: RuntimeProvider,
	result:
		| { status: "available"; data: ProviderQuotaData }
		| { status: "unsupported" }
		| { status: "error"; error: ProviderQuotaErrorCode },
): ProviderQuota {
	return {
		id: provider.id,
		name: provider.name,
		status: result.status,
		plan: null,
		windows: [],
		amounts: [],
		...(result.status === "available" ? result.data : {}),
		error: result.status === "error" ? result.error : null,
	};
}

interface ProviderQuotaCachePolicy {
	successMs: number;
	failureMs: number;
	rateLimitMs: number;
}

/** Shared reads belong to the cache; callers cancel their own wait without aborting another caller. */
export function createProviderQuotaCache() {
	// Bound retained credential generations, including reads still in flight during rapid account changes.
	const capacity = 32;
	const lifetime = new AbortController();
	const entries = new Map<string, { expiresAt: number; pending: boolean; request: Promise<ProviderQuotaData> }>();
	const pending = new Set<Promise<ProviderQuotaData>>();
	let disposal: Promise<void> | null = null;
	return {
		read(
			providerId: string,
			token: string,
			policy: ProviderQuotaCachePolicy,
			signal: AbortSignal,
			load: (signal: AbortSignal) => Promise<ProviderQuotaData>,
		): Promise<ProviderQuotaData> {
			throwIfOperationAborted(signal);
			throwIfOperationAborted(lifetime.signal);
			const key = createHash("sha256").update(providerId).update("\0").update(token).digest("base64url");
			const now = Date.now();
			for (const [key, entry] of entries) {
				if (!entry.pending && entry.expiresAt <= now) entries.delete(key);
			}
			const cached = entries.get(key);
			if (cached) return waitForOperation(cached.request, signal);
			if (entries.size >= capacity) {
				const retired = [...entries].find(([, entry]) => !entry.pending);
				if (!retired) throw new ProviderQuotaReadError("service");
				entries.delete(retired[0]);
			}
			const request = Promise.resolve().then(() => {
				throwIfOperationAborted(lifetime.signal);
				return load(lifetime.signal);
			});
			const entry = { request, expiresAt: now + policy.successMs, pending: true };
			entries.set(key, entry);
			pending.add(request);
			void request.then(
				() => {
					entry.pending = false;
					pending.delete(request);
				},
				(cause: unknown) => {
					entry.pending = false;
					pending.delete(request);
					entry.expiresAt =
						Date.now() + (quotaErrorCode(cause) === "rate-limit" ? policy.rateLimitMs : policy.failureMs);
				},
			);
			return waitForOperation(request, signal);
		},
		dispose(): Promise<void> {
			if (disposal) return disposal;
			lifetime.abort();
			entries.clear();
			disposal = Promise.allSettled([...pending]).then(() => undefined);
			return disposal;
		},
	};
}

export type ProviderQuotaCache = ReturnType<typeof createProviderQuotaCache>;

export class ProviderQuotaReadError extends Error {
	constructor(
		readonly code: ProviderQuotaErrorCode,
		cause?: unknown,
	) {
		super("Provider quota request failed", cause === undefined ? undefined : { cause });
	}
}

export class UnsupportedProviderQuotaError extends Error {
	constructor() {
		super("This provider configuration has no supported quota adapter");
	}
}

export function quotaErrorCode(cause: unknown): ProviderQuotaErrorCode {
	const error = toError(cause);
	return error instanceof ProviderQuotaReadError ? error.code : "service";
}

async function readBoundedResponse(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > PROVIDER_QUOTA_RESPONSE_MAX_BYTES) {
		void response.body?.cancel().catch(() => undefined);
		throw new ProviderQuotaReadError("invalid-response");
	}
	if (!response.body) throw new ProviderQuotaReadError("invalid-response");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let byteLength = 0;
	let chunkCount = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			chunkCount += 1;
			byteLength += chunk.value.byteLength;
			if (byteLength > PROVIDER_QUOTA_RESPONSE_MAX_BYTES || chunkCount > PROVIDER_QUOTA_RESPONSE_MAX_CHUNKS) {
				void reader.cancel().catch(() => undefined);
				throw new ProviderQuotaReadError("invalid-response");
			}
			if (chunk.value.byteLength === 0) continue;
			parts.push(decoder.decode(chunk.value, { stream: true }));
		}
		parts.push(decoder.decode());
		return parts.join("");
	} finally {
		reader.releaseLock();
	}
}

export async function requestJson(url: string, headers: HeadersInit, signal: AbortSignal): Promise<unknown> {
	const timeoutSignal = AbortSignal.timeout(PROVIDER_QUOTA_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeoutSignal]);
	let response: Response;
	try {
		response = await fetch(url, { headers, redirect: "error", signal: requestSignal });
	} catch (cause) {
		throwIfOperationAborted(signal);
		throw new ProviderQuotaReadError(timeoutSignal.aborted ? "timeout" : "network", cause);
	}

	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined);
		if (response.status === 401 || response.status === 403) throw new ProviderQuotaReadError("authentication");
		if (response.status === 429) throw new ProviderQuotaReadError("rate-limit");
		throw new ProviderQuotaReadError("service");
	}

	let body: string;
	try {
		body = await readBoundedResponse(response);
	} catch (cause) {
		throwIfOperationAborted(signal);
		if (timeoutSignal.aborted) throw new ProviderQuotaReadError("timeout", cause);
		if (toError(cause) instanceof ProviderQuotaReadError) throw cause;
		throw new ProviderQuotaReadError("network", cause);
	}
	try {
		return JSON.parse(body) as unknown;
	} catch (cause) {
		throw new ProviderQuotaReadError("invalid-response", cause);
	}
}

export function parsePayload<Output>(schema: z.ZodType<Output>, payload: unknown): Output {
	const result = schema.safeParse(payload);
	if (!result.success) throw new ProviderQuotaReadError("invalid-response", result.error);
	return result.data;
}

function authorizationToken(auth: ResolvedProviderAuth): string | null {
	const apiKey = auth.auth.apiKey?.trim();
	if (apiKey) return apiKey;
	for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
		if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
		const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
		if (match?.[1]) return match[1];
	}
	return null;
}

export async function resolveProviderAuth(
	runtime: QuotaRuntime,
	providerId: string,
	signal: AbortSignal,
): Promise<ResolvedProviderAuth> {
	try {
		const auth = await waitForOperation(runtime.getAuth(providerId, { signal }), signal);
		if (auth) return auth;
	} catch (cause) {
		throwIfOperationAborted(signal);
		throw new ProviderQuotaReadError("authentication", cause);
	}
	throw new ProviderQuotaReadError("authentication");
}

export async function resolveProviderToken(
	runtime: QuotaRuntime,
	providerId: string,
	signal: AbortSignal,
): Promise<string> {
	const token = authorizationToken(await resolveProviderAuth(runtime, providerId, signal));
	if (!token) throw new ProviderQuotaReadError("authentication");
	return token;
}

export function epochMilliseconds(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return null;
		const milliseconds = Math.round(value < EPOCH_MILLISECONDS_THRESHOLD ? value * MILLISECONDS_PER_SECOND : value);
		return Number.isSafeInteger(milliseconds) && Number.isFinite(new Date(milliseconds).getTime())
			? milliseconds
			: null;
	}
	if (value.length > PROVIDER_QUOTA_DATE_MAX_CHARS) return null;
	const numeric = /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : Number.NaN;
	if (Number.isFinite(numeric)) return epochMilliseconds(numeric);
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function numericValue(value: unknown): number | null {
	if (typeof value !== "number" && typeof value !== "string") return null;
	if (typeof value === "string" && (value.length > PROVIDER_QUOTA_DATE_MAX_CHARS || value.trim().length === 0))
		return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function nonnegativeValue(value: unknown): number | null {
	const parsed = numericValue(value);
	return parsed !== null && parsed >= 0 ? parsed : null;
}

export function boundedText(value: unknown): string | null {
	if (typeof value !== "string" || value.length > PROVIDER_QUOTA_TEXT_MAX_CHARS) return null;
	const text = value.trim();
	return text.length > 0 && text.length <= PROVIDER_QUOTA_TEXT_MAX_CHARS ? text : null;
}

export function firstBoundedText(...values: unknown[]): string | null {
	for (const value of values) {
		const text = boundedText(value);
		if (text) return text;
	}
	return null;
}

export function currencyCode(value: unknown): string | null {
	const currency = boundedText(value)?.toUpperCase();
	return currency && /^[A-Z]{3}$/u.test(currency) ? currency : null;
}

export function emptyWindow(
	id: string,
	kind: ProviderQuotaWindowKind,
	options: Partial<Omit<ProviderQuotaWindow, "id" | "kind">>,
): ProviderQuotaWindow {
	return {
		id,
		kind,
		label: null,
		usedPercent: null,
		used: null,
		limit: null,
		remaining: null,
		unit: null,
		durationSeconds: null,
		resetAt: null,
		unlimited: false,
		...options,
	};
}
