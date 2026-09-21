import {
	type GlobalInstructionFile,
	type GlobalInstructionKind,
	type GlobalInstructionLocation,
	GLOBAL_INSTRUCTION_FILE_NAMES,
} from "@ling/contracts/global-instructions";
import { globalInstructionsProcedures } from "@ling/contracts/global-instructions-procedures";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

/** Fixed path under Pi's global agent dir — the renderer never supplies a path. */
function resolveFilePath(agentDir: string, kind: GlobalInstructionKind): string {
	return join(agentDir, GLOBAL_INSTRUCTION_FILE_NAMES[kind]);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function createGlobalInstructionsDomain({ piWorker }: { piWorker: PiWorkerClient }): HostDomain {
	const handlers: HostHandlers = {
		[globalInstructionsProcedures.read.channel]: async (_event, kind): Promise<GlobalInstructionFile> => {
			const { agentDir } = await piWorker.getAgentInfo();
			const filePath = resolveFilePath(agentDir, kind);
			try {
				const content = await readFile(filePath, "utf8");
				return { kind: kind, content };
			} catch (error) {
				// Missing file is the normal "not configured yet" state, not an error.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: kind, content: null };
				throw error;
			}
		},

		[globalInstructionsProcedures.save.channel]: async (_event, request): Promise<GlobalInstructionFile> => {
			const { agentDir } = await piWorker.getAgentInfo();
			const filePath = resolveFilePath(agentDir, request.kind);
			// Empty/whitespace-only content removes the file so Pi stops loading it.
			if (request.content.trim() === "") {
				try {
					await rm(filePath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				return { kind: request.kind, content: null };
			}
			await writeFile(filePath, request.content, "utf8");
			return { kind: request.kind, content: request.content };
		},

		[globalInstructionsProcedures.reveal.channel]: async (_event, kind): Promise<GlobalInstructionLocation> => {
			const { agentDir } = await piWorker.getAgentInfo();
			const filePath = resolveFilePath(agentDir, kind);
			const exists = await pathExists(filePath);
			return {
				kind: kind,
				fileName: GLOBAL_INSTRUCTION_FILE_NAMES[kind],
				filePath,
				exists,
				dir: agentDir,
			};
		},

		[globalInstructionsProcedures.openDir.channel]: async (): Promise<{ dir: string }> => {
			const { agentDir: dir } = await piWorker.getAgentInfo();
			return { dir };
		},
	};
	return { handlers };
}
