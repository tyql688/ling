import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const CONTROL_MESSAGE_KIND = "ling-pi-control";

interface ControlEnvelope {
	kind: typeof CONTROL_MESSAGE_KIND;
	frame: unknown;
}

export interface PiWorkerControlPort {
	postMessage(message: unknown): void;
	on(event: "message", listener: (event: { data: unknown }) => void): this;
	on(event: "close", listener: () => void): this;
	off(event: "message", listener: (event: { data: unknown }) => void): this;
	start(): void;
	drain(): Promise<void>;
	close(): void;
}

function controlFrame(value: unknown): { frame: unknown } | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("kind" in value) ||
		value.kind !== CONTROL_MESSAGE_KIND ||
		!("frame" in value)
	) {
		return null;
	}
	return { frame: value.frame };
}

export class ParentPiWorkerControlPort extends EventEmitter implements PiWorkerControlPort {
	readonly #child: ChildProcess;
	#closed = false;

	constructor(child: ChildProcess) {
		super();
		this.#child = child;
	}

	postMessage(message: unknown): void {
		if (this.#closed || !this.#child.connected) throw new Error("Pi worker control port is closed");
		this.#child.send({ kind: CONTROL_MESSAGE_KIND, frame: message } satisfies ControlEnvelope);
	}

	accept(value: unknown): boolean {
		const envelope = controlFrame(value);
		if (envelope === null) return false;
		this.emit("message", { data: envelope.frame });
		return true;
	}

	start(): void {}
	drain(): Promise<void> {
		return Promise.resolve();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.emit("close");
		this.removeAllListeners();
	}
}

export class ChildPiWorkerControlPort extends EventEmitter implements PiWorkerControlPort {
	#closed = false;
	readonly #pendingSends = new Set<Promise<void>>();

	postMessage(message: unknown): void {
		if (this.#closed || !process.send) throw new Error("Pi worker control port is closed");
		let settle: ((error?: Error) => void) | null = null;
		const sent = new Promise<void>((resolve, reject) => {
			settle = (error) => (error ? reject(error) : resolve());
		});
		this.#pendingSends.add(sent);
		void sent.catch(() => undefined).finally(() => this.#pendingSends.delete(sent));
		process.send({ kind: CONTROL_MESSAGE_KIND, frame: message } satisfies ControlEnvelope, (error) =>
			settle?.(error ?? undefined),
		);
	}

	accept(value: unknown): boolean {
		const envelope = controlFrame(value);
		if (envelope === null) return false;
		this.emit("message", { data: envelope.frame });
		return true;
	}

	start(): void {}
	drain(): Promise<void> {
		return Promise.all([...this.#pendingSends]).then(() => undefined);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.emit("close");
		this.removeAllListeners();
	}
}
