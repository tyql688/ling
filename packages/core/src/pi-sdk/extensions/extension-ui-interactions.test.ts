import { describe, expect, it } from "vitest";
import { createExtensionUiInteractions } from "./extension-ui-interactions";
import { createPiExtensionUi } from "./extension-ui-context";
import { createExtensionUiBridge } from "../../pi-protocol/extension-ui";

describe("extension UI interaction cancellation", () => {
	it("opens voice settings through Pi's copied UI context and rejects it after replacement", async () => {
		const bridge = createExtensionUiBridge();
		const owner = createPiExtensionUi(bridge);
		const ref = { cwd: "/project", sessionId: "voice-session" };
		try {
			const copied = { ...owner.createPiExtensionUiContext(ref) };
			owner.openVoiceSettings(copied);
			const request = bridge.getExtensionUiState(ref).voiceSettingsRequestId;
			expect(request).toEqual(expect.any(String));
			owner.createPiExtensionUiContext(ref);
			expect(() => owner.openVoiceSettings(copied)).toThrow(
				expect.objectContaining({ code: "EXTENSION_UI_CONTEXT_STALE" }),
			);
			expect(bridge.getExtensionUiState(ref).voiceSettingsRequestId).toBe(request);
		} finally {
			await owner.dispose();
			bridge.dispose();
		}
	});
	it("cancels current waits and admits fresh interactions only after the stopped work settles", async () => {
		const owner = createExtensionUiInteractions();
		const original = owner.signal;
		const work = Promise.withResolvers<string>();
		let cancelledPanel = false;
		const stopping = owner.cancelWhile(
			() => {
				cancelledPanel = true;
			},
			() => work.promise,
		);
		expect(original.aborted).toBe(true);
		expect(original.reason).toMatchObject({ code: "REQUEST_CANCELLED" });
		expect(cancelledPanel).toBe(true);
		expect(() => owner.signal).toThrow();
		work.resolve("finished");
		await expect(stopping).resolves.toBe("finished");
		expect(owner.signal.aborted).toBe(false);
		expect(owner.signal).not.toBe(original);
	});

	it("keeps admission stopped until all overlapping cancellations finish", async () => {
		const owner = createExtensionUiInteractions();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const stoppingFirst = owner.cancelWhile(
			() => {},
			() => first.promise,
		);
		const stoppingSecond = owner.cancelWhile(
			() => {},
			() => second.promise,
		);
		first.resolve();
		await stoppingFirst;
		expect(() => owner.signal).toThrow();
		second.resolve();
		await stoppingSecond;
		expect(owner.signal.aborted).toBe(false);
	});

	it("does not reopen a context closed during an in-flight stop", async () => {
		const owner = createExtensionUiInteractions();
		const work = Promise.withResolvers<void>();
		const stopping = owner.cancelWhile(
			() => {},
			() => work.promise,
		);
		owner.close(new Error("Session disposed"));
		work.resolve();
		await stopping;
		expect(() => owner.signal).toThrow();
	});

	it("still aborts work after panel disposal fails and preserves both failures", async () => {
		const owner = createExtensionUiInteractions();
		const panelError = new Error("Panel disposal failed");
		const workError = new Error("Model abort failed");
		let abortAttempted = false;
		const result = await owner
			.cancelWhile(
				() => {
					throw panelError;
				},
				async () => {
					abortAttempted = true;
					throw workError;
				},
			)
			.catch((error: unknown) => error);
		expect(abortAttempted).toBe(true);
		expect(result).toBeInstanceOf(AggregateError);
		expect((result as AggregateError).errors).toEqual([panelError, workError]);
		expect(owner.signal.aborted).toBe(false);
	});

	it("keeps another session's interactions active", async () => {
		const first = createExtensionUiInteractions();
		const second = createExtensionUiInteractions();
		const untouched = second.signal;
		await first.cancelWhile(
			() => {},
			async () => {
				expect(untouched.aborted).toBe(false);
				expect(second.signal).toBe(untouched);
			},
		);
		expect(second.signal).toBe(untouched);
	});
});
