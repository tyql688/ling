import { describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge } from "./extension-ui";

const ref = { cwd: "/project", sessionId: "session" };

describe("extension UI bridge ownership", () => {
	it("keeps state and dialog requesters isolated between host instances", () => {
		const first = createExtensionUiBridge();
		const second = createExtensionUiBridge();
		const listener = vi.fn();
		second.onExtensionUiStateChanged(listener);
		const requester = async () => true;
		first.registerApprovalRequester(ref, requester);
		first.emitExtensionUiState(ref, { type: "status", key: "plugin", text: "ready" });
		expect(first.getApprovalRequester(ref)).toBe(requester);
		expect(second.getApprovalRequester(ref)).toBeUndefined();
		expect(second.getExtensionUiState(ref).statuses).toEqual([]);
		expect(listener).not.toHaveBeenCalled();
		first.dispose();
		second.dispose();
	});

	it("does not let an old dialog cleanup remove its replacement", () => {
		const bridge = createExtensionUiBridge();
		const previous = async () => false;
		const replacement = async () => true;
		bridge.registerApprovalRequester(ref, previous);
		bridge.registerApprovalRequester(ref, replacement);
		bridge.unregisterApprovalRequester(ref, previous);
		expect(bridge.getApprovalRequester(ref)).toBe(replacement);
		bridge.dispose();
	});

	it("publishes reset, clears editor state, and rejects late registrations after disposal", () => {
		const bridge = createExtensionUiBridge();
		const listener = vi.fn();
		const unsubscribe = bridge.onExtensionUiStateChanged(listener);
		bridge.setExtensionUiEditorTextMirror(ref, "draft");
		bridge.emitExtensionUiState(ref, { type: "status", key: "plugin", text: "ready" });
		bridge.resetExtensionUiState(ref);
		expect(bridge.getExtensionUiEditorText(ref)).toBe("");
		expect(listener).toHaveBeenLastCalledWith(ref, bridge.getExtensionUiState(ref), { type: "reset" });
		bridge.dispose();
		bridge.dispose();
		unsubscribe();
		expect(() => bridge.registerApprovalRequester(ref, async () => true)).toThrow(
			expect.objectContaining({ code: "REQUEST_CANCELLED" }),
		);
		expect(() => bridge.emitExtensionUiState(ref, { type: "title", title: "late" })).toThrow(
			expect.objectContaining({ code: "REQUEST_CANCELLED" }),
		);
	});
});
