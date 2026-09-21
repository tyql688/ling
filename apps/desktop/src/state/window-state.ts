import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonStateFile } from "./atomic-state-file";

export interface DesktopWindowState {
	x: number;
	y: number;
	width: number;
	height: number;
	maximized: boolean;
}

/** Smallest usable workbench viewport; the native window and persisted-state schema share this boundary. */
export const DESKTOP_WINDOW_MIN_SIZE = { width: 320, height: 480 } as const;
/** A 16,384-DIP ceiling rejects corrupt geometry while still covering extreme multi-monitor layouts. */
const DESKTOP_WINDOW_MAX_DIMENSION = 16_384;

const stateSchema: z.ZodType<DesktopWindowState> = z.strictObject({
	x: z.number().int(),
	y: z.number().int(),
	width: z.number().int().min(DESKTOP_WINDOW_MIN_SIZE.width).max(DESKTOP_WINDOW_MAX_DIMENSION),
	height: z.number().int().min(DESKTOP_WINDOW_MIN_SIZE.height).max(DESKTOP_WINDOW_MAX_DIMENSION),
	maximized: z.boolean(),
});
/** A window-state document has five scalar fields; 4 KiB rejects corruption without constraining valid geometry. */
const WINDOW_STATE_MAX_BYTES = 4 * 1_024;

export async function loadWindowState(userDataDirectory: string): Promise<DesktopWindowState | null> {
	const path = join(userDataDirectory, "window-state.json");
	try {
		const source = await readFile(path, "utf8");
		if (Buffer.byteLength(source) > WINDOW_STATE_MAX_BYTES) throw new Error("Window state exceeds its size bound");
		return stateSchema.parse(JSON.parse(source) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function saveWindowState(userDataDirectory: string, state: DesktopWindowState): Promise<void> {
	const validated = stateSchema.parse(state);
	const destination = join(userDataDirectory, "window-state.json");
	await writeJsonStateFile(destination, validated);
}
