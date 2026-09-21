import { getShellConfig, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@ling/contracts/records";
import { throwIfOperationAborted, waitForOperation } from "@ling/core/ling-error";
import { createAtomicFileStore } from "@ling/core/store/atomic-file-store";
import { exec, spawn } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** auth.json read byte limit (4MiB); credential files should be small, anything larger is suspected corruption/injection. */
const MAX_AUTH_JSON_BYTES = 4 * 1024 * 1024;
/** Subprocess timeout for resolving `!command` credentials; 10s matches the CLI and keeps hangs from blocking the read path. */
const COMMAND_TIMEOUT_MS = 10_000;
/** Credential command stdout limit (1MiB); normal secrets are far smaller, this guards against stdout floods. */
const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;
/**
 * `!command` results contain resolved secrets, so only a small LRU of recently used commands is kept. auth.json itself
 * has a 4MiB boundary, but a process may observe many different configs in sequence; the LRU keeps the module-level
 * cache from growing forever with history.
 */
const COMMAND_RESULT_CACHE_MAX_ENTRIES = 64;
/**
 * auth.json cross-process lock options. stale 30s clears dead locks; exponential-backoff retries cover CLI concurrent
 * writes so Ling and Pi avoid stepping on each other while sharing the file.
 */
const AUTH_FILE_LOCK_OPTIONS = {
	stale: 30_000,
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 10_000,
		randomize: true,
	},
} as const;

type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;
export type PiCredentialStore = NonNullable<ModelRuntimeOptions["credentials"]>;
type PiCredential = Awaited<ReturnType<PiCredentialStore["read"]>>;
type PresentCredential = Exclude<PiCredential, undefined>;
type PiCredentialOperationOptions = NonNullable<Parameters<PiCredentialStore["read"]>[1]>;
type CredentialFile = Record<string, unknown>;

export type PiStoredCredentialSnapshot =
	| { exists: false }
	| {
			exists: true;
			value: unknown;
	  };

export interface PiStoredCredentialMutation {
	previous: PiStoredCredentialSnapshot;
	attempted: PiStoredCredentialSnapshot;
}

/** Runs synchronously under auth.json's transaction lock immediately before a
 * credential publication. Throwing rejects that publication. */
export type PiStoredCredentialMutationObserver = (providerId: string, mutation: PiStoredCredentialMutation) => void;

/** A compensating target may be resolved synchronously while auth.json is locked,
 * so a higher-level transaction can recheck its owning configuration immediately
 * before the credential map changes. */
export type PiStoredCredentialRestoreTarget = PiStoredCredentialSnapshot | (() => PiStoredCredentialSnapshot);

/** Internal profile store capabilities that deliberately stay outside Pi's public
 * CredentialStore contract. Raw reads preserve `$ENV`/`!command` references for
 * the explicit reveal UI, and checked deletes revalidate scoped ownership while
 * holding the canonical auth.json transaction lock. */
export interface PiCredentialProfileStore extends PiCredentialStore {
	dispose(): Promise<void>;
	readStored(providerId: string, options?: PiCredentialOperationOptions): Promise<PiCredential>;
	modifyChecked(
		providerId: string,
		mutate: Parameters<PiCredentialStore["modify"]>[1],
		assertAllowed: () => void,
		options?: PiCredentialOperationOptions,
		observeMutation?: PiStoredCredentialMutationObserver,
	): ReturnType<PiCredentialStore["modify"]>;
	deleteChecked(providerId: string, assertAllowed: () => void, options?: PiCredentialOperationOptions): Promise<void>;
	/** Deletes and returns the exact JSON value while ownership is still valid and the
	 * canonical auth.json transaction lock is held. */
	deleteSnapshotChecked(
		providerId: string,
		assertAllowed: () => void,
		options?: PiCredentialOperationOptions,
	): Promise<PiStoredCredentialSnapshot>;
	/** Compensates a higher-level transaction without becoming a general unguarded
	 * write path. Unknown future credential shapes are preserved structurally as parsed
	 * JSON instead of being collapsed to an absent public credential. */
	restoreSnapshotChecked(
		providerId: string,
		attempted: PiStoredCredentialSnapshot,
		target: PiStoredCredentialRestoreTarget,
		options?: PiCredentialOperationOptions,
	): Promise<PiStoredCredentialSnapshot>;
}

function emptyCredentialFile(): CredentialFile {
	return {};
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** JSON permits an own "__proto__" field. defineProperty stores it as plain data
 * instead of invoking Object.prototype's legacy setter. */
function setCredentialEntry(credentials: CredentialFile, providerId: string, value: unknown): void {
	Object.defineProperty(credentials, providerId, {
		value: structuredClone(value),
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function cloneCredentialFile(value: Record<string, unknown>): CredentialFile {
	const clone = emptyCredentialFile();
	for (const [providerId, credential] of Object.entries(value)) {
		setCredentialEntry(clone, providerId, credential);
	}
	return clone;
}

function storedCredentialSnapshot(credentials: CredentialFile, providerId: string): PiStoredCredentialSnapshot {
	if (!Object.hasOwn(credentials, providerId)) return { exists: false };
	return { exists: true, value: structuredClone(credentials[providerId]) };
}

function writeStoredCredentialSnapshot(
	credentials: CredentialFile,
	providerId: string,
	snapshot: PiStoredCredentialSnapshot,
): void {
	if (!snapshot.exists) {
		delete credentials[providerId];
		return;
	}
	setCredentialEntry(credentials, providerId, snapshot.value);
}

function parseCredentialFile(source: string, path: string): CredentialFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`Invalid auth.json: ${path}`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`auth.json is not an object: ${path}`);
	return cloneCredentialFile(parsed);
}

function publicCredential(value: unknown): PresentCredential | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "api_key") {
		if (value.key !== undefined && typeof value.key !== "string") return undefined;
		if (value.env !== undefined && !isStringRecord(value.env)) return undefined;
		return structuredClone(value) as PresentCredential;
	}
	if (value.type === "oauth") {
		if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
			return undefined;
		}
		return structuredClone(value) as PresentCredential;
	}
	return undefined;
}

function environmentValue(name: string, credentialEnv: Record<string, string> | undefined): string | undefined {
	return credentialEnv?.[name] || process.env[name] || undefined;
}

function runDefaultShellCommand(command: string, signal: AbortSignal): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		exec(
			command,
			{ encoding: "utf8", maxBuffer: COMMAND_OUTPUT_MAX_BYTES, timeout: COMMAND_TIMEOUT_MS, windowsHide: true, signal },
			(error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
		);
	});
}

function runConfiguredWindowsShell(
	command: string,
	signal: AbortSignal,
): Promise<{ executed: boolean; value: string | undefined }> {
	let config: ReturnType<typeof getShellConfig>;
	try {
		config = getShellConfig();
	} catch {
		return Promise.resolve({ executed: false, value: undefined });
	}

	return new Promise((resolve) => {
		const commandFromStdin = config.commandTransport === "stdin";
		const child = spawn(config.shell, commandFromStdin ? config.args : [...config.args, command], {
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			timeout: COMMAND_TIMEOUT_MS,
			signal,
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let settled = false;
		const finish = (result: { executed: boolean; value: string | undefined }) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const stdout = child.stdout;
		const stdin = child.stdin;
		if (!stdout || (commandFromStdin && !stdin)) {
			child.kill();
			finish({ executed: true, value: undefined });
			return;
		}
		stdout.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes > COMMAND_OUTPUT_MAX_BYTES) {
				child.kill();
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({ executed: error.code !== "ENOENT", value: undefined });
		});
		child.on("close", (code) => {
			const value =
				code === 0 && totalBytes <= COMMAND_OUTPUT_MAX_BYTES ? Buffer.concat(chunks).toString("utf8").trim() : "";
			finish({ executed: true, value: value || undefined });
		});
		if (commandFromStdin) stdin?.end(command);
	});
}

async function executeConfigCommand(commandConfig: string, signal: AbortSignal): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	if (process.platform === "win32") {
		const configured = await runConfiguredWindowsShell(command, signal);
		if (configured.executed) return configured.value;
	}
	return runDefaultShellCommand(command, signal);
}

/**
 * One profile-owned implementation of pi-ai's public CredentialStore contract.
 * Every read observes canonical auth.json, while writes reuse Ling's bounded,
 * locked, atomic file boundary. ModelRuntime continues to own auth orchestration.
 */
export function createPiCredentialStore(agentDir: string): PiCredentialProfileStore {
	const lifetime = new AbortController();
	const pendingCommands = new Set<Promise<string | undefined>>();
	let disposal: Promise<void> | null = null;

	/** Pi auth.json values may be literals, shell commands, or environment templates; keep this aligned with Pi CLI. */
	async function resolveConfigValue(
		value: string,
		credentialEnv?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		throwIfOperationAborted(signal);
		if (value.startsWith("!")) return waitForOperation(runConfigCommand(value), signal);

		let resolved = "";
		for (let index = 0; index < value.length;) {
			if (value[index] !== "$") {
				resolved += value[index];
				index += 1;
				continue;
			}
			const next = value[index + 1];
			if (next === "$" || next === "!") {
				resolved += next;
				index += 2;
				continue;
			}
			if (next === "{") {
				const end = value.indexOf("}", index + 2);
				if (end < 0) {
					resolved += "$";
					index += 1;
					continue;
				}
				const name = value.slice(index + 2, end);
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
					resolved += value.slice(index, end + 1);
					index = end + 1;
					continue;
				}
				const replacement = environmentValue(name, credentialEnv);
				if (replacement === undefined) return undefined;
				resolved += replacement;
				index = end + 1;
				continue;
			}
			if (next !== undefined && /[A-Za-z_]/.test(next)) {
				let end = index + 2;
				while (end < value.length && /[A-Za-z0-9_]/.test(value[end] ?? "")) end += 1;
				const replacement = environmentValue(value.slice(index + 1, end), credentialEnv);
				if (replacement === undefined) return undefined;
				resolved += replacement;
				index = end;
				continue;
			}
			resolved += "$";
			index += 1;
		}
		throwIfOperationAborted(signal);
		return resolved;
	}

	function runConfigCommand(commandConfig: string): Promise<string | undefined> {
		const existing = commandResults.get(commandConfig);
		if (existing) {
			commandResults.delete(commandConfig);
			commandResults.set(commandConfig, existing);
			return existing;
		}
		throwIfOperationAborted(lifetime.signal);
		const running = executeConfigCommand(commandConfig, lifetime.signal);
		pendingCommands.add(running);
		void running.then(
			() => pendingCommands.delete(running),
			() => pendingCommands.delete(running),
		);
		commandResults.set(commandConfig, running);
		while (commandResults.size > COMMAND_RESULT_CACHE_MAX_ENTRIES) {
			const oldest = commandResults.keys().next().value;
			if (oldest === undefined) break;
			commandResults.delete(oldest);
		}
		return running;
	}

	const commandResults = new Map<string, Promise<string | undefined>>();

	const store = createAtomicFileStore<CredentialFile>({
		getPath: () => join(agentDir, "auth.json"),
		// Pi AuthStorage uses proper-lockfile's realpath-aware default. Resolve the
		// same target first so dotfile-managed auth.json symlinks share its lock.
		lockPath: "target",
		// Match Pi AuthStorage's cross-process OAuth refresh lock. A CLI may
		// legitimately hold this while awaiting the provider network response.
		lockOptions: AUTH_FILE_LOCK_OPTIONS,
		lockReads: true,
		maxBytes: MAX_AUTH_JSON_BYTES,
		create: emptyCredentialFile,
		parse: parseCredentialFile,
		serialize: (credentials) => `${JSON.stringify(credentials, null, 2)}\n`,
	});
	const readStored = async (providerId: string, options: PiCredentialOperationOptions = {}): Promise<PiCredential> =>
		publicCredential((await store.read(options))[providerId]);
	const modifyChecked: PiCredentialProfileStore["modifyChecked"] = (
		providerId,
		mutate,
		assertAllowed,
		options = {},
		observeMutation,
	) =>
		store.transact(async (credentials) => {
			const previous = storedCredentialSnapshot(credentials, providerId);
			const current = publicCredential(credentials[providerId]);
			const next = await mutate(current ? structuredClone(current) : undefined);
			// The provider callback may have waited on the network. Revalidate while
			// the canonical auth transaction is still held, immediately before its
			// credential map is changed, with no intervening await.
			assertAllowed();
			if (next === undefined) {
				return { commit: false, result: current ? structuredClone(current) : undefined };
			}
			const validated = publicCredential(next);
			if (!validated) throw new Error(`Invalid credential returned for provider: ${providerId}`);
			observeMutation?.(providerId, {
				previous,
				attempted: { exists: true, value: structuredClone(validated) },
			});
			setCredentialEntry(credentials, providerId, validated);
			return { commit: true, result: structuredClone(validated) };
		}, options);

	return {
		dispose(): Promise<void> {
			if (disposal) return disposal;
			lifetime.abort();
			commandResults.clear();
			disposal = Promise.allSettled([...pendingCommands]).then(() => undefined);
			return disposal;
		},
		async read(providerId, options = {}) {
			const credential = await readStored(providerId, options);
			if (credential?.type !== "api_key" || credential.key === undefined) return credential;
			const key = await resolveConfigValue(credential.key, credential.env, options.signal);
			throwIfOperationAborted(options.signal);
			const resolved = { ...credential };
			if (key === undefined) delete resolved.key;
			else resolved.key = key;
			return resolved;
		},
		async list(options = {}) {
			const entries: Awaited<ReturnType<PiCredentialStore["list"]>>[number][] = [];
			for (const [providerId, value] of Object.entries(await store.read(options))) {
				const credential = publicCredential(value);
				if (credential) entries.push({ providerId, type: credential.type });
			}
			throwIfOperationAborted(options.signal);
			return entries;
		},
		modify: (providerId, mutate, options) => modifyChecked(providerId, mutate, () => {}, options),
		delete(providerId, options = {}) {
			return store.transact((credentials) => {
				if (!Object.hasOwn(credentials, providerId)) return { commit: false, result: undefined };
				delete credentials[providerId];
				return { commit: true, result: undefined };
			}, options);
		},
		readStored,
		modifyChecked,
		deleteChecked(providerId, assertAllowed, options = {}) {
			return store.transact((credentials) => {
				// This callback runs only after the process queue and cooperative file
				// lock have both been acquired. Keep it synchronous so no stale scope
				// can cross an await between the final check and the mutation.
				assertAllowed();
				if (!Object.hasOwn(credentials, providerId)) return { commit: false, result: undefined };
				delete credentials[providerId];
				return { commit: true, result: undefined };
			}, options);
		},
		deleteSnapshotChecked(providerId, assertAllowed, options = {}) {
			return store.transact<PiStoredCredentialSnapshot>((credentials) => {
				assertAllowed();
				const previous = storedCredentialSnapshot(credentials, providerId);
				if (!previous.exists) return { commit: false, result: previous };
				delete credentials[providerId];
				return { commit: true, result: previous };
			}, options);
		},
		restoreSnapshotChecked(providerId, attempted, target, options = {}) {
			return store.transact((credentials) => {
				const resolvedTarget = typeof target === "function" ? target() : target;
				const current = storedCredentialSnapshot(credentials, providerId);
				if (isDeepStrictEqual(current, resolvedTarget)) {
					return { commit: false, result: structuredClone(resolvedTarget) };
				}
				if (!isDeepStrictEqual(current, attempted)) {
					throw new Error(`Credential for provider "${providerId}" changed before rollback`);
				}
				writeStoredCredentialSnapshot(credentials, providerId, resolvedTarget);
				return { commit: true, result: structuredClone(resolvedTarget) };
			}, options);
		},
	};
}
