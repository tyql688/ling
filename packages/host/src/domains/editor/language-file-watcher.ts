import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { toError } from "@ling/core/ling-error";
import { pathIdentity } from "@ling/core/paths";
import { subscribe } from "../../runtime/filesystem-watcher";

const method = "workspace/didChangeWatchedFiles";
const watcherSchema = z.object({
	globPattern: z.union([
		z.string().max(4_096),
		z.object({
			baseUri: z.union([z.string(), z.object({ uri: z.string() })]),
			pattern: z.string().max(4_096),
		}),
	]),
	kind: z.number().int().min(1).max(7).optional(),
});
const registrationsSchema = z.object({
	registrations: z.array(z.object({ id: z.string(), method: z.string(), registerOptions: z.unknown() })).max(128),
});

/** Own one native subscription for a language connection, only while the server needs it. */
export function createLanguageFileWatcher(options: {
	cwd: string;
	notify(method: string, params: unknown): Promise<void>;
	onError(error: Error): void;
}) {
	const registrations = new Map<string, Array<{ pattern: string; kind: number }>>();
	let subscription: Awaited<ReturnType<typeof subscribe>> | undefined;
	let operations = Promise.resolve();
	let closed = false;
	let pending = 0;
	const failure = (error: unknown) => {
		if (closed) return;
		closed = true;
		options.onError(toError(error));
	};
	function enqueue(action: () => Promise<void>): Promise<void> {
		const operation = operations.then(action);
		operations = operation.catch(() => undefined);
		return operation;
	}
	function patterns(value: unknown) {
		return z
			.object({ watchers: z.array(watcherSchema).max(256) })
			.parse(value)
			.watchers.map((watcher) => {
				const glob = watcher.globPattern;
				const base =
					typeof glob === "string"
						? options.cwd
						: fileURLToPath(typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri.uri);
				return {
					pattern: pathIdentity(resolve(base, typeof glob === "string" ? glob : glob.pattern)),
					kind: watcher.kind ?? 7,
				};
			});
	}
	async function reconcile() {
		if (closed || registrations.size === 0) {
			await subscription?.unsubscribe();
			subscription = undefined;
			return;
		}
		if (subscription) return;
		subscription = await subscribe(
			options.cwd,
			(error, events) => {
				if (closed) return;
				if (error) return failure(error);
				const changes: Array<{ uri: string; type: number }> = [];
				for (const event of events) {
					const path = relative(options.cwd, event.path);
					if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) continue;
					// FSEvents can merge creation and subsequent writes. Invalidate previously read
					// content first: TypeScript discards changes following a create in the same batch.
					const bits = event.type === "create" ? [2, 1] : [event.type === "update" ? 2 : 4];
					for (const bit of bits) {
						const matches = [...registrations.values()].some((watchers) =>
							watchers.some(
								(watcher) => (watcher.kind & bit) !== 0 && matchesGlob(pathIdentity(event.path), watcher.pattern),
							),
						);
						if (!matches) continue;
						// Stop an overwhelmed connection before allocating an unbounded notification batch.
						if (pending + changes.length >= 4_096)
							return failure(new Error("Language file changes exceed the notification budget"));
						changes.push({ uri: pathToFileURL(event.path).href, type: bit === 4 ? 3 : bit });
					}
				}
				if (!changes.length) return;
				pending += changes.length;
				void options
					.notify(method, { changes })
					.catch(failure)
					.finally(() => {
						pending -= changes.length;
					});
			},
			{ ignore: ["**/.git/**"] },
		);
	}
	return {
		register(value: unknown) {
			return enqueue(async () => {
				if (closed) throw new Error("Language file watcher is closed");
				const incoming = registrationsSchema.parse(value).registrations.filter((entry) => entry.method === method);
				const next = new Map(registrations);
				for (const entry of incoming) next.set(entry.id, patterns(entry.registerOptions));
				// Bound server-controlled retained patterns independently of each registration request.
				if (next.size > 128 || [...next.values()].reduce((count, watchers) => count + watchers.length, 0) > 1_024)
					throw new Error("Too many language file watchers");
				registrations.clear();
				for (const [id, watchers] of next) registrations.set(id, watchers);
				await reconcile();
			});
		},
		unregister(value: unknown) {
			return enqueue(async () => {
				// The spelling is part of LSP's original wire contract.
				const request = z
					.object({ unregisterations: z.array(z.object({ id: z.string(), method: z.string() })).max(128) })
					.parse(value);
				for (const entry of request.unregisterations) if (entry.method === method) registrations.delete(entry.id);
				await reconcile();
			});
		},
		dispose() {
			closed = true;
			return enqueue(async () => {
				registrations.clear();
				await reconcile();
			});
		},
	};
}
