import { ATTACHMENT_UPLOAD_MAX_BYTES } from "@ling/contracts/attachments";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Imported bytes are durable user attachments: Pi histories keep their paths after a restart.
 * The Host owns active transfers and removes incomplete files on disconnect or shutdown. */
export function createAttachmentFiles(dataHome: string) {
	const active = new Map<Promise<string>, AbortController>();
	let stopping = false;
	async function store(cwd: string, name: string, request: Readable, signal: AbortSignal): Promise<string> {
		const project = createHash("sha256").update(cwd).digest("hex");
		let fileName = name
			.replace(/[<>:"/\\|?*]/g, "_")
			.replace(/\p{Cc}/gu, "_")
			.replace(/[. ]+$/, "");
		// Leave room for the unique prefix, retaining the extension used by media previews.
		const extension = extname(fileName);
		const suffix = Buffer.byteLength(extension, "utf8") <= 160 ? extension : "";
		const stem = Array.from(suffix ? fileName.slice(0, -suffix.length) : fileName);
		while (Buffer.byteLength(stem.join("") + suffix, "utf8") > 160) stem.pop();
		fileName = stem.join("") + suffix;
		const directory = join(dataHome, "attachments", project);
		await mkdir(directory, { recursive: true });
		const destination = join(directory, `${randomUUID()}-${fileName || "attachment"}`);
		const temporary = `${destination}.part`;
		let received = 0;
		const limit = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				received += chunk.byteLength;
				callback(
					received > ATTACHMENT_UPLOAD_MAX_BYTES ? new Error("Attachment upload exceeds the transfer limit") : null,
					chunk,
				);
			},
		});
		try {
			await pipeline(request, limit, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
			signal.throwIfAborted();
			await rename(temporary, destination);
			return destination;
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}
	const prepareShutdown = () => {
		stopping = true;
		for (const controller of active.values()) controller.abort();
	};
	return {
		prepareShutdown,
		store(cwd: string, name: string, request: Readable): Promise<string> {
			if (stopping) return Promise.reject(new Error("Attachment uploads are shutting down"));
			const controller = new AbortController();
			const operation = store(cwd, name, request, controller.signal);
			active.set(operation, controller);
			return operation.finally(() => active.delete(operation));
		},
		async dispose() {
			prepareShutdown();
			await Promise.allSettled(active.keys());
		},
	};
}
