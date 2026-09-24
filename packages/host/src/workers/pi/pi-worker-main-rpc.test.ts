import { describe, expect, it } from "vitest";
import { createExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { PI_WORKER_PROTOCOL_VERSION } from "@ling/core/pi-protocol/wire-format";
import { createPiWorkerMainRpc } from "./pi-worker-main-rpc";

describe("companion tool callbacks", () => {
	it("forwards a tool call with the request signal and validates the Host result", async () => {
		const bridge = createExtensionUiBridge();
		const seen: string[] = [];
		const rpc = createPiWorkerMainRpc({
			extensionUi: bridge,
			getRuntime: () => undefined,
			getCreation: () => undefined,
			runPluginTool: async () => "",
			runMcpTool: async () => "",
			promptProjectTrust: async () => null,
			turnLifecycleHost: { start: async () => {}, finish: async () => {} },
			readAdapterPlan: async () => ({
				features: {
					todo: true,
					permissions: true,
					questions: true,
					"background-tasks": true,
					schedules: true,
					voice: true,
					mcp: false,
				},
				voice: null,
				mcp: null,
				todo: null,
				permissions: null,
			}),
			async invokeCompanionTool(call, signal) {
				seen.push(call.name);
				expect(signal.aborted).toBe(false);
				return { content: [{ type: "text", text: "ok" }], details: { echoed: call.input } };
			},
		});
		try {
			const result = await rpc.handle(
				{
					kind: "mainRequest",
					protocolVersion: PI_WORKER_PROTOCOL_VERSION,
					generation: 1,
					requestId: "call",
					deadlineAt: null,
					method: "companions.invoke",
					params: {
						name: "background_list",
						ref: { cwd: "/project", sessionId: "session" },
						input: {},
					},
				},
				new AbortController().signal,
			);
			expect(seen).toEqual(["background_list"]);
			expect(result).toEqual({ content: [{ type: "text", text: "ok" }], details: { echoed: {} } });
		} finally {
			await rpc.abortGeneration(1);
			bridge.dispose();
		}
	});
});
