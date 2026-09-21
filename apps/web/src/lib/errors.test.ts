import type { LingErrorDto } from "@ling/contracts/ling-error";
import i18next from "i18next";
import { describe, expect, it, vi } from "vitest";
import { formatRequestError, isExpectedCancellation, isExpectedCompanionRace, isTranscriptCursorStale } from "./errors";

const translate = vi.fn((key: string, options: Record<string, unknown>) => `${key}:${JSON.stringify(options)}`);
describe("localized boundary errors", () => {
	it("recognizes transported lifecycle errors without classifying their message", () => {
		expect(isExpectedCancellation(Object.assign(new Error("wording"), { code: "REQUEST_CANCELLED" }))).toBe(true);
		expect(isExpectedCompanionRace(Object.assign(new Error("wording"), { code: "STALE_STATE_REVISION" }))).toBe(true);
		expect(isTranscriptCursorStale(Object.assign(new Error("wording"), { code: "TRANSCRIPT_CURSOR_EXPIRED" }))).toBe(
			true,
		);
		expect(isExpectedCancellation(new Error("REQUEST_CANCELLED"))).toBe(false);
	});
	it("keeps diagnostic identifiers and localization for callers without a translator", async () => {
		await i18next.init({
			lng: "en",
			resources: {
				en: { translation: { errors: { missingGit: "Install Git", requestFailed: "Request failed. Please retry." } } },
			},
		});
		const dto: LingErrorDto = {
			code: "INTERNAL_ERROR",
			category: "runtime",
			retryable: false,
			message: "Ling host request failed",
			causeId: "cause-123",
		};
		expect(formatRequestError(Object.assign(new Error(dto.message), { lingError: dto }))).toBe(
			"Request failed. Please retry. (cause-123)",
		);
		expect(formatRequestError({ ...dto, code: "COMMAND_NOT_FOUND", details: { executable: "git" } })).toBe(
			"Install Git",
		);
	});
	it("localizes DTOs and transported Errors by executable identity, irrespective of message text", () => {
		for (const executable of ["npm", "git"]) {
			const dto: LingErrorDto = {
				code: "COMMAND_NOT_FOUND",
				category: "external",
				retryable: false,
				message: "upstream wording changed",
				details: { executable },
			};
			const expected = `errors.missing${executable === "npm" ? "Npm" : "Git"}:{}`;
			expect(formatRequestError(dto, translate)).toBe(expected);
			expect(formatRequestError(Object.assign(new Error(dto.message), { lingError: dto }), translate)).toBe(expected);
		}
	});
	it("preserves ordinary text and structured failures that lack command identity", () => {
		const message = "Git executable was not found on PATH.";
		expect(formatRequestError(new Error(message), translate)).toBe(message);
		expect(
			formatRequestError({ code: "COMMAND_NOT_FOUND", category: "external", retryable: false, message }, translate),
		).toBe(message);
		expect(
			formatRequestError(
				{ code: "INTERNAL_ERROR", category: "runtime", retryable: false, message: "failed", causeId: "request-123" },
				translate,
			),
		).toBe("errors.requestFailed:{} (request-123)");
	});
	it("interpolates arbitrary command labels without classifying similar English messages", () => {
		expect(
			formatRequestError(
				{
					code: "COMMAND_NOT_FOUND",
					category: "external",
					retryable: false,
					message: "missing",
					details: { executable: "custom", label: "/tools/custom" },
				},
				translate,
			),
		).toBe('errors.missingExecutable:{"executable":"/tools/custom"}');
	});
});
