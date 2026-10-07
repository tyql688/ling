import {
	SESSION_TREE_PAGE_SIZE,
	SESSION_TRANSFER_MAX_BYTES,
	type SessionInspection,
	type SessionControl,
} from "@ling/contracts/session-inspection";
import { readUtf8FileBounded } from "../../store/atomic-file-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiAgentSessionRuntime } from "../types";
import type { PiRuntimeOperationCoordinator } from "./runtime-operations";
import type { createPiRuntimeSessionActions } from "./runtime-session-actions";
import { importPiSession } from "./session-import";
import { readSessionToolFilter } from "./session-tool-filter";
import type { SessionToolFilter } from "@ling/contracts/session-tool-filter";
import { createLingError } from "../../ling-error";

export function createPiRuntimeInspection(owner: {
	runtime(): PiAgentSessionRuntime;
	operations: PiRuntimeOperationCoordinator;
	sessionActions: Pick<ReturnType<typeof createPiRuntimeSessionActions>, "navigateTree">;
	isBusy(): boolean;
	changed(): void;
	updateToolFilter(filter: SessionToolFilter): Promise<void>;
	importSession(path: string): Promise<{ cancelled: boolean }>;
}) {
	return {
		inspectSession(offset: number): Promise<SessionInspection> {
			const busy = owner.isBusy();
			return owner.operations.runBackground(async () => {
				const { session, services } = owner.runtime();
				const manager = session.sessionManager;
				const entries: { entry: ReturnType<typeof manager.getEntries>[number]; branchDepth: number }[] = [];
				const stack = manager
					.getTree()
					.reverse()
					.map((node) => ({ node, branchDepth: 0 }));
				while (stack.length) {
					const current = stack.pop()!;
					entries.push({ entry: current.node.entry, branchDepth: current.branchDepth });
					for (const node of [...current.node.children].reverse())
						stack.push({ node, branchDepth: current.branchDepth + (current.node.children.length > 1 ? 1 : 0) });
				}
				const branch = new Set(manager.getBranch().map((entry) => entry.id));
				const active = new Set(session.getActiveToolNames());
				const extensions = services.resourceLoader.getExtensions();
				const flags = new Map<string, SessionInspection["flags"][number]>();
				for (const extension of extensions.extensions)
					for (const [name, flag] of extension.flags) {
						if (!flags.has(name))
							flags.set(name, {
								name,
								description: (flag.description ?? "").slice(0, 4096),
								type: flag.type,
								value: extensions.runtime.flagValues.get(name) ?? null,
							});
					}
				const cache = session.cacheWarmingStatus;
				return {
					leafId: manager.getLeafId(),
					busy,
					toolFilter: readSessionToolFilter(manager),
					total: entries.length,
					offset,
					entries: entries.slice(offset, offset + SESSION_TREE_PAGE_SIZE).map(({ entry, branchDepth }) => {
						const content =
							entry.type === "message" && "content" in entry.message
								? entry.message.content
								: entry.type === "custom_message"
									? entry.content
									: entry.type === "compaction" || entry.type === "branch_summary"
										? entry.summary
										: "";
						const text =
							typeof content === "string"
								? content.slice(0, 512)
								: Array.isArray(content)
									? content
											.filter((part) => part.type === "text")
											.map((part) => part.text.slice(0, 512))
											.join(" ")
											.slice(0, 512)
									: "";
						return {
							id: entry.id,
							parentId: entry.parentId,
							branchDepth,
							onCurrentBranch: branch.has(entry.id),
							type: entry.type,
							role: entry.type === "message" ? entry.message.role : null,
							text,
							timestamp: entry.timestamp,
							label: manager.getLabel(entry.id) ?? null,
						};
					}),
					tools: session.getAllTools().map((tool) => ({
						name: tool.name,
						description: tool.description.slice(0, 4096),
						active: active.has(tool.name),
					})),
					flags: [...flags.values()],
					systemPrompt: session.systemPrompt.slice(0, 1024 * 1024),
					systemPromptTruncated: session.systemPrompt.length > 1024 * 1024,
					context: session.getContextUsage() ?? null,
					cache: cache
						? {
								state: cache.state,
								reason: cache.reason ?? null,
								nextWarmAt: cache.nextWarmAt ?? null,
								warmCost: cache.decision?.warmCost ?? null,
								expectedSavings: cache.decision?.expectedSavings ?? null,
								extensionOverride: cache.extensionOverride ?? false,
							}
						: null,
				};
			});
		},
		controlSession(action: SessionControl) {
			if (action.type === "toolFilter") return owner.updateToolFilter(action.filter).then(() => ({ cancelled: false }));
			if (action.type === "navigate")
				return owner.operations.runOrderedMutation(async () => {
					const result = await owner.sessionActions.navigateTree(action.entryId, {
						summarize: action.summarize,
						...(action.customInstructions === undefined ? {} : { customInstructions: action.customInstructions }),
					});
					return {
						cancelled: result.cancelled,
						...(result.editorText === undefined ? {} : { editorText: result.editorText }),
					};
				});
			return owner.operations.runOrderedMutation(() => {
				const { session, services } = owner.runtime();
				if (!session.isIdle) throw new Error("Wait for the current turn before changing session controls");
				switch (action.type) {
					case "tool": {
						const available = new Set(session.getAllTools().map((tool) => tool.name));
						if (!available.has(action.name)) throw new Error("The available tools changed. Refresh before saving.");
						const names = new Set(session.getActiveToolNames());
						if (action.enabled) names.add(action.name);
						else names.delete(action.name);
						session.setActiveToolsByName([...names]);
						if (session.getActiveToolNames().includes(action.name) !== action.enabled) {
							throw createLingError({
								code: "INVALID_REQUEST",
								category: "validation",
								message:
									"Pi could not change this tool. Check the session tool filter and the tool's exposure settings.",
								retryable: false,
							});
						}
						break;
					}
					case "flag": {
						const extensions = services.resourceLoader.getExtensions();
						const flag = extensions.extensions
							.flatMap((extension) => [...extension.flags.values()])
							.find((flag) => flag.name === action.name);
						if (!flag || flag.type !== typeof action.value)
							throw new Error("The extension flag is unavailable or its type changed");
						extensions.runtime.flagValues.set(action.name, action.value);
						break;
					}
					case "label":
						if (!session.sessionManager.getEntry(action.entryId)) throw new Error("The session entry is unavailable");
						session.sessionManager.appendLabelChange(action.entryId, action.label || undefined);
						break;
				}
				owner.changed();
				return { cancelled: false };
			});
		},
		importSession(content: string) {
			return importPiSession(content, owner.runtime().session.sessionManager.getCwd(), owner.importSession);
		},
		exportSession(format: "html" | "jsonl") {
			return owner.operations.runBackground(async () => {
				const directory = await mkdtemp(join(tmpdir(), "ling-session-export-"));
				try {
					const { session } = owner.runtime();
					const path = join(directory, `session.${format}`);
					if (format === "html") await session.exportToHtml(path);
					else session.exportToJsonl(path);
					const content = await readUtf8FileBounded(path, SESSION_TRANSFER_MAX_BYTES);
					if (content === undefined) throw new Error("Pi did not create the requested export");
					return {
						name: `${session.sessionManager.getSessionId()}.${format}`,
						content,
						mimeType: format === "html" ? "text/html" : "application/x-ndjson",
					};
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			});
		},
	};
}
