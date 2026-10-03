import { readUtf8FileBounded, writeTextFileAtomic } from "@ling/core/store/atomic-file-store";
import { piResourceReloadError, type ResourceReloadCoordinator } from "../resources/resource-reload";
import {
	type GlobalInstructionFile,
	type GlobalInstructionKind,
	type GlobalInstructionLocation,
	GLOBAL_INSTRUCTION_FILE_NAMES,
	GLOBAL_INSTRUCTION_MAX_BYTES,
} from "@ling/contracts/global-instructions";
import { globalInstructionsProcedures } from "@ling/contracts/global-instructions-procedures";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { rm, stat } from "node:fs/promises";
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

export function createGlobalInstructionsDomain({
	piWorker,
	resources,
}: {
	piWorker: PiWorkerClient;
	resources: ResourceReloadCoordinator;
}): HostDomain {
	const handlers: HostHandlers = {
		[globalInstructionsProcedures.read.channel]: async (_event, kind): Promise<GlobalInstructionFile> => {
			const { agentDir } = await piWorker.getAgentInfo();
			const filePath = resolveFilePath(agentDir, kind);
			return { kind, content: (await readUtf8FileBounded(filePath, GLOBAL_INSTRUCTION_MAX_BYTES)) ?? null };
		},

		[globalInstructionsProcedures.save.channel]: async (_event, request): Promise<GlobalInstructionFile> => {
			const { agentDir } = await piWorker.getAgentInfo();
			const filePath = resolveFilePath(agentDir, request.kind);
			const content = request.content.trim() === "" ? null : request.content;
			const { mutation, reload } = await resources.mutateThenReloadPiResources(
				"Failed to save and apply global instructions",
				async () => {
					if (content === null) await rm(filePath, { force: true });
					else await writeTextFileAtomic(filePath, content);
				},
			);
			if (mutation.failed) {
				const reloadError = piResourceReloadError(reload, "Global instruction reconciliation failed");
				if (reloadError)
					throw new AggregateError([mutation.error, reloadError], "Saving and applying global instructions failed");
				throw mutation.error;
			}
			return { kind: request.kind, content, reload };
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
