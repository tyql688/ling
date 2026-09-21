import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonStateFile } from "./atomic-state-file";

interface GraphicsState {
	softwareRendering: boolean;
	autoFallback: boolean;
}

const graphicsStateSchema: z.ZodType<GraphicsState> = z.strictObject({
	softwareRendering: z.boolean(),
	autoFallback: z.boolean(),
});
/** Two boolean fields; 1 KiB rejects corruption without constraining valid documents. */
const GRAPHICS_STATE_MAX_BYTES = 1_024;

/** Read synchronously so the accelerator decision can happen before Electron is ready. */
export function readGraphicsState(userDataDirectory: string): GraphicsState {
	const path = join(userDataDirectory, "graphics-state.json");
	try {
		const source = readFileSync(path, "utf8");
		if (Buffer.byteLength(source) > GRAPHICS_STATE_MAX_BYTES) throw new Error("Graphics state exceeds its size bound");
		return graphicsStateSchema.parse(JSON.parse(source) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { softwareRendering: false, autoFallback: false };
		throw error;
	}
}

export async function writeGraphicsState(userDataDirectory: string, state: GraphicsState): Promise<void> {
	const validated = graphicsStateSchema.parse(state);
	const destination = join(userDataDirectory, "graphics-state.json");
	await writeJsonStateFile(destination, validated);
}
