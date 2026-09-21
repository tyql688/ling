import { projectProcedures } from "@ling/contracts/project-procedures";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { describe, expect, it } from "vitest";
import { normalizeRequestError, isExpectedRequestControlFlow } from "../transport/request-error";
import { createHostRequestRouter } from "../transport/request-router";
import { createHostDomainRuntime } from "./domain-runtime";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";

describe("Host runtime ownership", () => {
	it("keeps reload and replacement contention as retryable lifecycle outcomes", () => {
		for (const code of ["SESSION_RESOURCE_RELOAD_BUSY", "SESSION_REPLACEMENT_BUSY", "SESSION_LIFECYCLE_CONFLICT"]) {
			const failure = normalizeRequestError(Object.assign(new Error("private runtime details"), { code }), {
				fallbackMessage: "Request failed",
			});
			expect(failure).toMatchObject({
				code: "SESSION_LIFECYCLE_CONFLICT",
				category: "lifecycle",
				retryable: true,
				userAction: "retry",
			});
			expect(failure.message).not.toContain("private runtime details");
			expect(isExpectedRequestControlFlow(failure)).toBe(true);
		}
	});

	it("validates native paths and positional dialog replies before invoking a handler", async () => {
		const router = createHostRequestRouter();
		const context = { clientId: "client", product: "web" as const, signal: new AbortController().signal };
		let calls = 0;
		router.handle(projectProcedures.add.channel, async () => {
			calls += 1;
		});
		router.handle(
			sessionProcedures.respondToApproval.channel,
			async (_context, requestId: string, approved: boolean) => ({ requestId, approved }),
		);
		try {
			await expect(router.dispatch(projectProcedures.add.channel, context, ["relative/project"])).rejects.toMatchObject(
				{ code: "INVALID_REQUEST" },
			);
			expect(calls).toBe(0);
			await expect(
				router.dispatch(sessionProcedures.respondToApproval.channel, context, ["approval", true]),
			).resolves.toEqual({ requestId: "approval", approved: true });
			await expect(
				router.dispatch(sessionProcedures.respondToApproval.channel, context, ["approval", "true"]),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			expect(() => router.assertComplete()).toThrow("Missing Host handlers");
			const original = normalizeRequestError(new Error("private failure details"), {
				fallbackMessage: "Request failed",
			});
			const transported = Object.assign(new Error(original.message), { code: original.code, lingError: original });
			expect(normalizeRequestError(transported, { fallbackMessage: "Request failed" })).toEqual(original);
			expect(original.message).toBe("Request failed");
		} finally {
			router.stop();
		}
	});
	it("stops admission synchronously and drains dependents before their providers", async () => {
		const trace: string[] = [];
		const lifetime = createRuntimeLifetime(["sessions", "providers"]);
		const session = Promise.withResolvers<void>();
		lifetime.onStop("admission", () => {
			trace.push("stop");
		});
		lifetime.defer("providers", "worker", () => {
			trace.push("worker");
		});
		lifetime.defer("sessions", "session", async () => {
			trace.push("session");
			await session.promise;
			trace.push("drained");
		});
		const closing = lifetime.dispose();
		expect(lifetime.dispose()).toBe(closing);
		expect(trace).toEqual(["stop", "session"]);
		expect(() => lifetime.defer("sessions", "late", () => undefined)).toThrow();
		session.resolve();
		await closing;
		expect(trace).toEqual(["stop", "session", "drained", "worker"]);
	});

	it("runs all cleanup and preserves startup plus rollback errors", async () => {
		const lifetime = createRuntimeLifetime(["one", "two"]);
		const startup = new Error("startup");
		const cleanup = new Error("cleanup");
		let released = false;
		lifetime.defer("one", "failed owner", () => {
			throw cleanup;
		});
		lifetime.defer("two", "remaining owner", () => {
			released = true;
		});
		await expect(lifetime.fail(startup)).rejects.toMatchObject({ errors: [startup, { errors: [{ cause: cleanup }] }] });
		expect(released).toBe(true);
		await expect(lifetime.dispose()).rejects.toThrow("Runtime shutdown failed");
	});

	it("rolls back the domain whose registration fails and still drains the remaining owners", async () => {
		const router = createHostRequestRouter();
		const domains = createHostDomainRuntime(router.handle);
		const released: string[] = [];
		const cleanupError = new Error("subscription cleanup failed");
		domains.add("worker", "workers", () => ({
			handlers: { "network:getProxy": async () => "ready" },
			dispose() {
				released.push("worker");
			},
		}));
		let startupError: unknown;
		try {
			domains.add("subscription", "handlers", () => ({
				handlers: { "network:getProxy": async () => "duplicate" },
				prepareShutdown() {
					released.push("stop");
				},
				dispose() {
					released.push("subscription");
					throw cleanupError;
				},
			}));
		} catch (error) {
			startupError = error;
		}
		expect(startupError).toBeInstanceOf(Error);
		router.stop();
		await expect(domains.fail(startupError)).rejects.toMatchObject({
			errors: [startupError, { errors: [{ cause: cleanupError }] }],
		});
		expect(released).toEqual(["stop", "subscription", "worker"]);
	});

	it("refuses domain construction once shutdown starts", async () => {
		const router = createHostRequestRouter();
		const domains = createHostDomainRuntime(router.handle);
		let constructed = false;
		domains.prepareShutdown();
		expect(() =>
			domains.add("late", "workers", () => {
				constructed = true;
				return { handlers: {} };
			}),
		).toThrow("Cannot acquire resources");
		expect(constructed).toBe(false);
		router.stop();
		await domains.dispose();
	});
});
