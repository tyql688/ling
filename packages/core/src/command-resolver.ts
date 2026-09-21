import which from "which";
import { createLingError, isLingError, toError } from "./ling-error";

interface ResolveCommandOptions {
	path?: string;
	pathExt?: string;
}

export function resolveCommand(command: string, options: ResolveCommandOptions = {}): string | undefined {
	return which.sync(command, { ...options, nothrow: true }) ?? undefined;
}

/** Preflight and spawn failures share a structured error, independent of presentation wording. */
export function requireCommand(command: string, options: ResolveCommandOptions = {}): string {
	const resolved = resolveCommand(command, options);
	if (resolved) return resolved;
	throw missingCommandError(command);
}

function commandName(command: string): string {
	return (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe|bat|com)$/i, "").toLowerCase();
}

function commandHint(command: string): { label: string; installHint: string } {
	switch (commandName(command)) {
		case "npm":
			return {
				label: "npm",
				installHint: "Reinstall Ling, or configure a working npm command in Settings.",
			};
		case "git":
			return { label: "Git", installHint: "Install Git and make sure it is available on PATH." };
		default:
			return { label: command, installHint: "Install it and make sure it is available on PATH." };
	}
}

function missingCommandError(command: string, cause?: unknown): Error {
	const { label, installHint } = commandHint(command);
	return createLingError(
		{
			code: "COMMAND_NOT_FOUND",
			category: "external",
			message: `${label} executable was not found on PATH. ${installHint}`,
			retryable: false,
			details: { executable: commandName(command), command, label },
		},
		cause,
	);
}

function normalizeCommandError(error: unknown): Error | null {
	const err = error as NodeJS.ErrnoException | undefined;
	let command: string | null = null;
	if (err?.code === "ENOENT" && typeof err.syscall === "string" && err.syscall.startsWith("spawn ")) {
		command = typeof err.path === "string" ? err.path : err.syscall.slice("spawn ".length).trim();
	}

	if (!command) return null;
	return missingCommandError(command, error);
}

/** Like `toError`, but maps spawn-ENOENT failures to a friendly "X was not found on PATH" message. */
export function toCommandError(error: unknown): Error {
	if (isLingError(error)) return error;
	return normalizeCommandError(error) ?? toError(error);
}
