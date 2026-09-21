import { record } from "@ling/contracts/records";

/** The durable envelope of a delivered question answer; arbitrary Pi custom messages keep their own presentation. */
export function questionAnswerText(value: unknown): string | null {
	const message = record(value);
	const details = record(message?.details);
	return message?.role === "custom" &&
		message.display === true &&
		typeof message.content === "string" &&
		typeof details?.feature === "string" &&
		typeof details.requestId === "string" &&
		message.customType === `ling-answer:${details.feature}:${details.requestId}`
		? message.content
		: null;
}
