import { createExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { afterEach, describe, expect, it } from "vitest";
import { createHostClientState } from "../../transport/client-state";
import { createHostEventBus } from "../../transport/event-bus";
import type { HostShellActivity } from "../../transport/shell-activity";
import { createSessionDialogHost } from "./session-dialog-host";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createHarness(notify?: HostShellActivity["notify"]) {
	const ref = { cwd: "/project", sessionId: "session" };
	const extensionUi = createExtensionUiBridge();
	const notifications: Array<Parameters<HostShellActivity["notify"]>> = [];
	const host = createSessionDialogHost(createHostEventBus(), createHostClientState(), {
		registry: {
			setApprovalRequester: extensionUi.registerApprovalRequester,
			setExtensionUiRequester: extensionUi.registerExtensionUiRequester,
		},
		extensionUi,
		shellActivity: {
			notify: (...args) => {
				notifications.push(args);
				notify?.(...args);
			},
		},
	});
	cleanups.push(extensionUi.dispose, host.dispose, host.bind(ref));
	const approval = extensionUi.getApprovalRequester(ref);
	const input = extensionUi.getExtensionUiRequester(ref);
	if (!approval || !input) throw new Error("Dialog binding did not install requesters");
	return { ref, host, notifications, approval, input };
}

describe("session attention routing", () => {
	it("clears the pending approval when notification transport fails", () => {
		const failure = new Error("Shell transport closed");
		const { ref, host, approval } = createHarness(() => {
			throw failure;
		});
		expect(() => approval({ ref, title: "Read", message: "Arguments" })).toThrow(failure);
		expect(host.pendingApprovals()).toEqual([]);
	});

	it("notifies once when approval is pending without exposing tool arguments", async () => {
		const { ref, host, notifications, approval } = createHarness();
		const answer = approval({ ref, title: "Read workspace file", message: "Private tool arguments" });
		expect(notifications).toEqual([[ref, "attentionNeeded", "Ling — approval needed", "Read workspace file"]]);
		const [pending] = host.pendingApprovals();
		if (!pending) throw new Error("Approval was not retained");
		host.respondApproval(pending.requestId, true);
		await expect(answer).resolves.toBe(true);
		expect(host.pendingApprovals()).toEqual([]);
		expect(notifications).toHaveLength(1);
	});

	it("routes extension input through the same attention owner and drains it on shutdown", async () => {
		const { ref, host, notifications, input } = createHarness();
		const answer = input(ref, { kind: "input", title: "Choose a branch", placeholder: "main" });
		expect(notifications).toEqual([[ref, "attentionNeeded", "Ling — input needed", "Choose a branch"]]);
		host.dispose();
		await expect(answer).resolves.toBeUndefined();
		expect(host.pendingExtensionUi()).toEqual([]);
	});

	it("does not publish an alert or pending card for already cancelled requests", async () => {
		const { ref, host, notifications, approval, input } = createHarness();
		const controller = new AbortController();
		controller.abort();
		await expect(
			approval({ ref, title: "Read", message: "Arguments", options: { signal: controller.signal } }),
		).resolves.toBe(false);
		await expect(
			input(ref, { kind: "input", title: "Input", placeholder: null, promptOptions: { signal: controller.signal } }),
		).resolves.toBeUndefined();
		expect(host.pendingApprovals()).toEqual([]);
		expect(host.pendingExtensionUi()).toEqual([]);
		expect(notifications).toEqual([]);
	});
});
