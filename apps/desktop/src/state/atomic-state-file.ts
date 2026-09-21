import { createAtomicTextFileWriter } from "@ling/node-runtime/atomic-file";

const writeState = createAtomicTextFileWriter({
	// Native state is private even when a pre-existing file has broader permissions.
	mode: 0o600,
	onWarning: (context, error) => console.error(`[native-state] ${context}:`, error),
});

export async function writeJsonStateFile(destination: string, value: unknown): Promise<void> {
	await writeState(destination, `${JSON.stringify(value)}\n`);
}
