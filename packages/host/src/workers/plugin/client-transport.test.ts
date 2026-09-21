import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLUGIN_HOST_PROTOCOL_VERSION,
	type PluginHostRequestPayload,
	type PluginHostTransport,
} from "@ling/core/plugin-host/protocol";
import { createPluginHostTransport, type PluginHostClientTransport } from "./client-transport";

const clients = new Set<PluginHostClientTransport>();

function createTransport() {
	const sent: Array<{ id: string }> = [];
	let receive!: (message: unknown) => void;
	let exit!: (code: number | undefined) => void;
	const transport: PluginHostTransport = {
		postMessage: (message) => {
			const frame = z.object({ t: z.literal("q"), i: z.string().optional(), m: z.string() }).parse(message);
			if (frame.m === "request") {
				if (!frame.i) throw new Error("Missing RPC id");
				sent.push({ id: frame.i });
			}
		},
		onMessage: (listener) => {
			receive = listener;
			return () => {
				receive = () => undefined;
			};
		},
		onExit: (listener) => {
			exit = listener;
		},
		kill: vi.fn(async () => undefined),
	};
	const client = createPluginHostTransport(() => transport);
	clients.add(client);
	return {
		client,
		transport,
		sent,
		receive: ({ id, ...response }: { id: string; [key: string]: unknown }) => receive({ t: "s", i: id, r: response }),
		exit: () => exit(1),
	};
}

function request(method: "resolve" | "install", deadline = 1000): PluginHostRequestPayload {
	const base = { protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION, cwd: "/project", deadlineAt: Date.now() + deadline };
	return method === "resolve"
		? { ...base, method, projectTrusted: true }
		: { ...base, method, source: "npm:example", scope: "project" };
}

const emptyInventory = { configuredPackages: [], resources: [], missingSources: [] };

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(async () => {
	await Promise.all([...clients].map((client) => client.dispose()));
	clients.clear();
	vi.useRealTimers();
});

describe("plugin request ownership over birpc", () => {
	it("preserves typed command failures without overriding an uncertain write outcome", async () => {
		for (const outcome of ["knownFailed", "unknown"] as const) {
			const host = createTransport();
			const pending = host.client.requestPluginHost(request("install"));
			const rejected = expect(pending).rejects.toMatchObject({
				code: outcome === "knownFailed" ? "COMMAND_NOT_FOUND" : "PACKAGE_OPERATION_UNCERTAIN",
			});
			host.receive({
				kind: "error",
				id: host.sent[0]!.id,
				method: "install",
				error: {
					code: "PI_PACKAGE_OPERATION_FAILED",
					message: "missing",
					retryable: false,
					outcome,
					cause: {
						code: "COMMAND_NOT_FOUND",
						category: "external",
						message: "missing",
						retryable: false,
						details: { executable: "npm", label: "npm" },
					},
				},
			});
			await rejected;
		}
	});
	it("isolates matching request ids, listeners and disposal between Host instances", async () => {
		const first = createTransport();
		const second = createTransport();
		const firstRead = first.client.requestPluginHost(request("resolve"));
		const secondRead = second.client.requestPluginHost(request("resolve"));
		const lost = expect(firstRead).rejects.toMatchObject({ code: "PACKAGE_HOST_LOST" });
		const disposal = first.client.dispose();
		expect(first.client.dispose()).toBe(disposal);
		await disposal;
		await lost;
		expect(second.transport.kill).not.toHaveBeenCalled();
		second.receive({ kind: "result", id: second.sent[0]!.id, method: "resolve", result: emptyInventory });
		await expect(secondRead).resolves.toEqual(emptyInventory);
	});
	it("matches concurrent reads by id and bounds admission", async () => {
		const host = createTransport();
		const reads = Array.from({ length: 28 }, () => host.client.requestPluginHost(request("resolve")));
		const outcomes = Promise.allSettled(reads);
		expect(() => host.client.requestPluginHost(request("resolve"))).toThrow(
			expect.objectContaining({ code: "REQUEST_CAPACITY_EXCEEDED" }),
		);
		const ids = host.sent.map((message) => {
			if (!("id" in message)) throw new Error("Expected request");
			return message.id;
		});
		expect(new Set(ids).size).toBe(28);
		for (const id of ids.toReversed()) host.receive({ kind: "result", id, method: "resolve", result: emptyInventory });
		expect((await outcomes).every((outcome) => outcome.status === "fulfilled")).toBe(true);
	});
	it("rejects an aborted read and all siblings owned by the lost host", async () => {
		const host = createTransport();
		const controller = new AbortController();
		const first = host.client.requestPluginHost(request("resolve"), controller.signal);
		const second = host.client.requestPluginHost(request("resolve"));
		const outcomes = Promise.allSettled([first, second]);
		controller.abort();
		expect(await outcomes).toMatchObject([
			{ status: "rejected", reason: { code: "REQUEST_CANCELLED" } },
			{ status: "rejected", reason: { code: "PACKAGE_HOST_LOST" } },
		]);
		expect(host.transport.kill).toHaveBeenCalledOnce();
	});
	it("does not cancel an admitted mutation when the caller aborts", async () => {
		const host = createTransport();
		const controller = new AbortController();
		const pending = host.client.requestPluginHost(request("install"), controller.signal);
		controller.abort();
		const frame = host.sent[0];
		if (!frame || !("id" in frame)) throw new Error("Expected mutation request");
		host.receive({
			kind: "result",
			id: frame.id,
			method: "install",
			result: { completed: true, settingsChanged: "changed", scopePrecision: "exact" },
		});
		await expect(pending).resolves.toMatchObject({ completed: true });
		expect(host.transport.kill).not.toHaveBeenCalled();
	});
	it("reports late mutation settlement after an uncertain deadline", async () => {
		const host = createTransport();
		const settled = vi.fn();
		const unsubscribe = host.client.onLatePluginMutationSettlement(settled);
		const pending = host.client.requestPluginHost(request("install", 100));
		const failed = expect(pending).rejects.toMatchObject({ code: "PACKAGE_OPERATION_UNCERTAIN" });
		await vi.advanceTimersByTimeAsync(100);
		await failed;
		expect(host.transport.kill).not.toHaveBeenCalled();
		const frame = host.sent[0];
		if (!frame || !("id" in frame)) throw new Error("Expected mutation request");
		host.receive({
			kind: "result",
			id: frame.id,
			method: "install",
			result: { completed: true, settingsChanged: "changed", scopePrecision: "exact" },
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ cwd: "/project", method: "install", outcome: "completed" });
		unsubscribe();
	});
	it("retires malformed hosts and rejects every pending read", async () => {
		const host = createTransport();
		const reads = Promise.allSettled([
			host.client.requestPluginHost(request("resolve")),
			host.client.requestPluginHost(request("resolve")),
		]);
		host.receive({
			kind: "result",
			id: host.sent[0]!.id,
			method: "resolve",
			result: { configuredPackages: "invalid" },
		});
		expect(await reads).toMatchObject([
			{ status: "rejected", reason: { code: "PACKAGE_HOST_LOST" } },
			{ status: "rejected", reason: { code: "PACKAGE_HOST_LOST" } },
		]);
		expect(host.transport.kill).toHaveBeenCalledOnce();
	});
	it("clears instance-owned maps and listeners on shutdown", async () => {
		const host = createTransport();
		const reads = Promise.allSettled([host.client.requestPluginHost(request("resolve"))]);
		await host.client.dispose();
		expect(await reads).toMatchObject([{ status: "rejected" }]);
		expect(vi.getTimerCount()).toBe(0);
		expect(() => host.client.requestPluginHost(request("resolve"))).toThrow(
			expect.objectContaining({ code: "REQUEST_CANCELLED" }),
		);
	});
	it("keeps admitted writes alive when another read is cancelled", async () => {
		const host = createTransport(),
			controller = new AbortController();
		const write = host.client.requestPluginHost(request("install"));
		const read = host.client.requestPluginHost(request("resolve"), controller.signal);
		const rejected = expect(read).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		controller.abort();
		await rejected;
		expect(host.transport.kill).not.toHaveBeenCalled();
		host.receive({
			kind: "result",
			id: host.sent[0]!.id,
			method: "install",
			result: { completed: true, settingsChanged: "changed", scopePrecision: "exact" },
		});
		await expect(write).resolves.toMatchObject({ completed: true });
	});
	it("holds late mutations against capacity and reports each grace expiry once", async () => {
		const host = createTransport(),
			settled = vi.fn();
		host.client.onLatePluginMutationSettlement(settled);
		const writes = Array.from({ length: 4 }, () => host.client.requestPluginHost(request("install", 100)));
		const results = Promise.allSettled(writes);
		await vi.advanceTimersByTimeAsync(100);
		await results;
		expect(() => host.client.requestPluginHost(request("install"))).toThrow(
			expect.objectContaining({ code: "REQUEST_CAPACITY_EXCEEDED" }),
		);
		await vi.advanceTimersByTimeAsync(60000);
		expect(host.transport.kill).toHaveBeenCalledOnce();
		expect(settled).toHaveBeenCalledTimes(4);
		expect(settled.mock.calls.every(([value]) => value.outcome === "failed")).toBe(true);
	});
	it("treats a failed mutation send as uncertain and retires its transport", async () => {
		const host = createTransport();
		host.transport.postMessage = () => {
			throw new Error("Send failed");
		};
		await expect(host.client.requestPluginHost(request("install"))).rejects.toMatchObject({
			code: "PACKAGE_OPERATION_UNCERTAIN",
		});
		expect(host.transport.kill).toHaveBeenCalledOnce();
	});
});
