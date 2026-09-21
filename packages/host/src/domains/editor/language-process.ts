import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	CancellationTokenSource,
} from "vscode-jsonrpc/node";
import { languageLimits } from "@ling/contracts/editor-language";
import { toCommandError } from "@ling/core/command-resolver";
import { toError } from "@ling/core/ling-error";
import { terminateProcessTree } from "@ling/node-runtime/process-tree-terminator";

/** Check Content-Length before the RPC reader retains a server-controlled body. */
export function createLanguageFrameLimit(): Transform {
	let header = Buffer.alloc(0),
		remaining = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			try {
				let offset = 0;
				while (offset < chunk.length) {
					if (remaining > 0) {
						const consumed = Math.min(remaining, chunk.length - offset);
						remaining -= consumed;
						offset += consumed;
						continue;
					}
					const end = chunk.indexOf("\r\n\r\n", offset);
					// At most 8 KiB of headers; incomplete delimiter bytes are retained between chunks.
					const length = end < 0 ? Math.min(chunk.length - offset, 8_193) : end + 4 - offset;
					header = Buffer.concat([header, chunk.subarray(offset, offset + length)]);
					const delimiter = header.indexOf("\r\n\r\n");
					if (delimiter > 8_192) throw new Error("Language server header is too large");
					if (delimiter < 0) {
						if (header.length > 8_192) throw new Error("Language server header is too large");
						offset += length;
						continue;
					}
					const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header.subarray(0, delimiter).toString("ascii"));
					const size = match ? Number(match[1]) : NaN;
					if (!Number.isSafeInteger(size) || size < 0 || size > languageLimits.responseBytes)
						throw new Error("Language server frame exceeds the response budget");
					const includedBody = header.length - delimiter - 4;
					remaining = size;
					offset += length - includedBody;
					header = Buffer.alloc(0);
				}
				callback(null, chunk);
			} catch (error) {
				callback(toError(error));
			}
		},
	});
}

export function createLanguageProcess(options: {
	command: string;
	args: string[];
	cwd: string;
	onFailure(error: Error): void;
	onNotification(method: string, value: unknown): void;
	onRequest(method: string, value: unknown): unknown;
}) {
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	const frames = createLanguageFrameLimit();
	const reader = new StreamMessageReader(child.stdout.pipe(frames));
	const rpc = createMessageConnection(reader, new StreamMessageWriter(child.stdin));
	let closed = false,
		stderr = "",
		disposing: Promise<void> | null = null;
	const pending = new Map<string, { source: CancellationTokenSource; reject(error: Error): void }>();
	const fail = (cause: unknown) => {
		if (closed) return;
		closed = true;
		const error = toCommandError(cause);
		for (const request of pending.values()) {
			request.source.cancel();
			request.reject(error);
		}
		pending.clear();
		rpc.dispose();
		options.onFailure(error);
		void stop().catch(options.onFailure);
	};
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-8_192);
	});
	child.on("error", fail);
	child.on("exit", (code, signal) =>
		fail(new Error(`Language server exited (${code ?? signal})${stderr ? `: ${stderr}` : ""}`)),
	);
	frames.on("error", fail);
	rpc.onError(([error]) => fail(error));
	rpc.onClose(() => fail(new Error("Language server disconnected")));
	rpc.onNotification((method, value) => {
		try {
			options.onNotification(method, value);
		} catch (error) {
			fail(error);
		}
	});
	rpc.onRequest((method, value) => options.onRequest(method, value));
	rpc.listen();
	function request(
		method: string,
		params: unknown,
		signal?: AbortSignal,
		id: string = crypto.randomUUID(),
	): Promise<unknown> {
		if (closed) return Promise.reject(new Error("Language server is closed"));
		if (pending.size >= 64 || pending.has(id)) return Promise.reject(new Error("Language request queue is full"));
		const source = new CancellationTokenSource();
		return new Promise((resolve, reject) => {
			const cancel = () => {
				source.cancel();
				reject(signal?.reason ?? new Error("Language request cancelled"));
			};
			// Indexing is bounded separately from interactive completion; an unresponsive service is stopped.
			const timer = setTimeout(
				() => fail(new Error(`Language server timed out: ${method}`)),
				method === "initialize" ? 30_000 : 15_000,
			);
			const finish = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				source.dispose();
				pending.delete(id);
			};
			pending.set(id, { source, reject });
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) {
				cancel();
				finish();
				return;
			}
			void rpc.sendRequest(method, params, source.token).then(resolve, reject).finally(finish);
		});
	}
	async function stop(): Promise<void> {
		if (disposing) return disposing;
		disposing = (async () => {
			closed = true;
			for (const item of [...pending.values()]) {
				item.source.cancel();
				item.reject(new Error("Language server stopped"));
			}
			rpc.dispose();
			reader.dispose();
			frames.destroy();
			child.stdin.destroy();
			if (child.pid !== undefined)
				await terminateProcessTree({
					pid: child.pid,
					terminateRoot: () => {
						child.kill();
					},
					rootExited: () => child.exitCode !== null || child.signalCode !== null,
				});
		})();
		return disposing;
	}
	return {
		request,
		notify: (method: string, params: unknown) => rpc.sendNotification(method, params),
		cancel(id: string) {
			const item = pending.get(id);
			if (item) {
				item.source.cancel();
				item.reject(new Error("Language request cancelled"));
			}
		},
		stop,
	};
}
export type LanguageProcess = ReturnType<typeof createLanguageProcess>;
