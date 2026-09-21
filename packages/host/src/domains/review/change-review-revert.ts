import { requireCommand, toCommandError } from "@ling/core/command-resolver";
import { spawn } from "node:child_process";

/** Timeout for `git apply` dry-run/real application. 30s covers medium patches; a stuck process must be killed, or it holds the workspace lock and blocks later reverts. */
const GIT_APPLY_TIMEOUT_MS = 30_000;
/** Git diagnostics are useful, but a hook/config failure must not stream forever into RAM. */
const GIT_APPLY_STDERR_MAX_BYTES = 256 * 1_024;

function runGitApply(cwd: string, args: readonly string[], patch: string): Promise<void> {
	const command = requireCommand("git");
	return new Promise((resolve, reject) => {
		const stderr: Buffer[] = [];
		let stderrBytes = 0;
		let terminalError: Error | null = null;
		let settled = false;
		const child = spawn(command, [...args], { cwd, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`git ${args.join(" ")} exceeded ${GIT_APPLY_TIMEOUT_MS} ms`));
		}, GIT_APPLY_TIMEOUT_MS);
		child.stderr.on("data", (chunk: Buffer) => {
			if (terminalError) return;
			if (stderrBytes + chunk.byteLength > GIT_APPLY_STDERR_MAX_BYTES) {
				terminalError = new Error(`git ${args.join(" ")} stderr exceeded ${GIT_APPLY_STDERR_MAX_BYTES} bytes`);
				child.kill("SIGKILL");
				return;
			}
			stderrBytes += chunk.byteLength;
			stderr.push(chunk);
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(toCommandError(error));
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (terminalError) reject(terminalError);
			else if (code === 0) resolve();
			else
				reject(
					new Error(Buffer.concat(stderr).toString("utf8").trim() || `git apply exited with code ${String(code)}`),
				);
		});
		child.stdin.on("error", () => {
			// A failed write surfaces through the close handler's exit code.
		});
		child.stdin.end(patch);
	});
}

async function applyCheckedTurnPatch(cwd: string, patch: string, reverse: boolean): Promise<void> {
	const direction = reverse ? ["--reverse"] : [];
	try {
		await runGitApply(cwd, ["apply", ...direction, "--check", "--whitespace=nowarn", "-"], patch);
	} catch (error) {
		throw new Error(
			reverse
				? "The workspace no longer matches this turn's result; revert was aborted"
				: "The workspace no longer accepts this turn's patch; restore was aborted",
			{
				cause: toCommandError(error),
			},
		);
	}
	await runGitApply(cwd, ["apply", ...direction, "--whitespace=nowarn", "-"], patch);
}

/** Reverse-applies a combined per-turn patch. The dry run must pass in full before any
 * file is touched, so a workspace that has since diverged is rejected without partial
 * application. `git apply` works in plain directories too — no repository required. */
export function reverseApplyTurnPatch(cwd: string, patch: string): Promise<void> {
	return applyCheckedTurnPatch(cwd, patch, true);
}

/** Re-applies a turn patch only to roll back a completed filesystem revert when the
 * corresponding non-Git review-state transaction cannot be persisted. */
export function restoreTurnPatch(cwd: string, patch: string): Promise<void> {
	return applyCheckedTurnPatch(cwd, patch, false).catch((error) => {
		throw new Error("Ling could not restore the workspace after review-state persistence failed", {
			cause: toCommandError(error),
		});
	});
}
