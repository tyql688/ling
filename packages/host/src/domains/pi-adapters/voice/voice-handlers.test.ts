import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { VoiceTranscribeRequest } from "@ling/contracts/voice";
import type { HostRequestContext } from "../../../transport/request-router";
import { createResourceReloadCoordinator } from "../../resources/resource-reload";
import { createVoiceDomain } from "./voice-handlers";

function fixture() {
	const context: HostRequestContext = { clientId: "owner", product: "web", signal: new AbortController().signal };
	const requireEnabled = vi.fn(async () => {});
	const reloadProjectSettings = vi.fn(async () => {});
	const reloadSessionResources = vi.fn(async () => ({
		revision: 1,
		reloaded: 0,
		deferred: 0,
		failed: [],
		failedOmitted: 0,
	}));
	const resources = createResourceReloadCoordinator({ reloadProjectSettings, reloadSessionResources });
	const transcribeVoice = vi.fn(async (_input: VoiceTranscribeRequest, _signal?: AbortSignal) => ({ text: "hello" }));
	const configureVoice = vi.fn(async () => {});
	const domain = createVoiceDomain({
		features: { requireEnabled },
		resources,
		assertProject: async () => {},
		piWorker: { readVoice: vi.fn(), transcribeVoice, configureVoice },
	});
	const input = { operationId: randomUUID(), cwd: "/project", pcm: "AAAA" };
	return {
		context,
		domain,
		input,
		transcribeVoice,
		configureVoice,
		requireEnabled,
		reloadProjectSettings,
		reloadSessionResources,
		resources,
	};
}

it("only lets the owning client cancel, fences late results, and releases capacity after cancellation", async () => {
	const f = fixture();
	const started = Promise.withResolvers<AbortSignal>();
	const result = Promise.withResolvers<{ text: string }>();
	f.transcribeVoice.mockImplementationOnce(async (_input, signal) => {
		started.resolve(signal!);
		return result.promise;
	});
	const first = f.domain.handlers["voice:transcribe"](f.context, f.input);
	const outcome = expect(first).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
	const signal = await started.promise;
	await expect(
		f.domain.handlers["voice:transcribe"](f.context, { ...f.input, operationId: randomUUID() }),
	).rejects.toMatchObject({ code: "REQUEST_CAPACITY_EXCEEDED" });
	await f.domain.handlers["voice:cancel"]({ ...f.context, clientId: "other" }, f.input);
	expect(signal.aborted).toBe(false);
	await f.domain.handlers["voice:cancel"](f.context, f.input);
	expect(signal.aborted).toBe(true);
	result.resolve({ text: "late result" });
	await outcome;
	await expect(
		f.domain.handlers["voice:transcribe"](f.context, { ...f.input, operationId: randomUUID() }),
	).resolves.toEqual({ text: "hello" });
	await f.domain.dispose();
	await f.resources.dispose();
});

it("rejects work when disabled and drains a disconnected client's operation before shutdown", async () => {
	const f = fixture();
	f.requireEnabled.mockRejectedValueOnce(new Error("disabled"));
	await expect(f.domain.handlers["voice:transcribe"](f.context, f.input)).rejects.toThrow("disabled");
	expect(f.transcribeVoice).not.toHaveBeenCalled();
	const started = Promise.withResolvers<AbortSignal>();
	f.transcribeVoice.mockImplementationOnce(async (_input, signal) => {
		started.resolve(signal!);
		return new Promise((_resolve, reject) =>
			signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
		);
	});
	const work = f.domain.handlers["voice:transcribe"](f.context, f.input);
	const outcome = expect(work).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
	await started.promise;
	f.domain.disconnectClient("other");
	expect((await started.promise).aborted).toBe(false);
	f.domain.disconnectClient("owner");
	await f.domain.dispose();
	await outcome;
	await expect(f.domain.handlers["voice:read"](f.context, { cwd: "/project" })).rejects.toMatchObject({
		code: "REQUEST_CANCELLED",
	});
	await f.resources.dispose();
});

it("reconciles partial configuration writes and preserves mutation and reload failures", async () => {
	const f = fixture();
	f.configureVoice.mockRejectedValueOnce(new Error("model settings write failed"));
	f.reloadProjectSettings.mockRejectedValueOnce(new Error("project reload failed"));
	const operation = f.domain.handlers["voice:configure"](f.context, {
		cwd: "/project",
		operationId: randomUUID(),
		download: false,
		configuration: { modelId: "model", language: "en", chineseOutput: "simplified" },
	});
	await expect(operation).rejects.toMatchObject({
		errors: [
			expect.objectContaining({ message: "model settings write failed" }),
			expect.objectContaining({ code: "PI_RESOURCE_RELOAD_INCOMPLETE" }),
		],
	});
	expect(f.reloadProjectSettings).toHaveBeenCalledOnce();
	expect(f.reloadSessionResources).toHaveBeenCalledOnce();
	await f.domain.dispose();
	await f.resources.dispose();
});
