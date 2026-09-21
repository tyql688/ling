import { describe, expect, it } from "vitest";
import { requireCommand, toCommandError } from "./command-resolver";
import { isLingError } from "./ling-error";
import { piWorkerError, piWorkerErrorDto } from "./pi-protocol/protocol-validation";

describe("missing command boundary", () => {
	it("resolves an existing command and identifies an absent executable without shell execution", () => {
		expect(requireCommand(process.execPath)).toBe(process.execPath);
		expect(() => requireCommand("ling-nonexistent-probe-command", { path: "/ling-nonexistent-search-path" })).toThrow(
			expect.objectContaining({ code: "COMMAND_NOT_FOUND" }),
		);
	});
	it("normalizes structured spawn failures independently of their wording", () => {
		const source = Object.assign(new Error("arbitrary upstream copy"), {
			code: "ENOENT",
			syscall: "spawn git",
			path: "git",
		});
		const error = toCommandError(source);
		expect(error).toMatchObject({
			code: "COMMAND_NOT_FOUND",
			cause: source,
			lingError: { details: { executable: "git", label: "Git" } },
		});
		expect(toCommandError(error)).toBe(error);
	});
	it("does not mistake missing files or presentation text for an absent command", () => {
		for (const error of [
			Object.assign(new Error("missing file"), { code: "ENOENT", syscall: "open", path: "/file" }),
			new Error("spawn git ENOENT"),
			new Error("Git executable was not found on PATH."),
		])
			expect(toCommandError(error)).toBe(error);
	});
	it("retains recovery metadata through Pi serialization while preserving extension error codes", () => {
		const source = toCommandError(
			Object.assign(new Error("missing"), { code: "ENOENT", syscall: "spawn npm", path: "npm" }),
		);
		const received = piWorkerError(piWorkerErrorDto(source));
		expect(isLingError(received)).toBe(true);
		expect(received).toMatchObject({
			lingError: { code: "COMMAND_NOT_FOUND", category: "external", details: { executable: "npm" } },
		});
		const extension = piWorkerError({ code: "CUSTOM_EXTENSION_ERROR", message: "custom", retryable: false });
		expect(extension).toMatchObject({ code: "CUSTOM_EXTENSION_ERROR" });
		expect(isLingError(extension)).toBe(false);
	});
});
