import type { OpenProjectInfo, ProjectTrustRequest } from "@ling/contracts/project";
import type { UserStateMutation } from "@ling/contracts/user-state";
import { userStateFieldAtom } from "@renderer/lib/user-state/state";
import { atom } from "jotai";

export const openProjectsAtom = atom<OpenProjectInfo[]>([]);
export const projectTrustQueueAtom = atom<ProjectTrustRequest[]>([]);
export const pinnedProjectCwdsAtom = userStateFieldAtom("pinnedProjectCwds", (before, after) => [
	...before.filter((cwd) => !after.includes(cwd)).map((cwd) => ({ type: "projectPin" as const, cwd, pinned: false })),
	...after
		.filter((cwd) => !before.includes(cwd))
		.reverse()
		.map((cwd) => ({ type: "projectPin" as const, cwd, pinned: true })),
]);
export const projectDisplayNamesAtom = userStateFieldAtom("projectDisplayNames", (before, after) => {
	const mutations: UserStateMutation[] = [];
	for (const cwd of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (before[cwd] !== after[cwd]) mutations.push({ type: "projectName", cwd, name: after[cwd] ?? null });
	}
	return mutations;
});
export const sidebarProjectScopeAtom = userStateFieldAtom("sidebarProjectScope", (_before, cwd) => [
	{ type: "sidebarScope", cwd },
]);
/** The global new-conversation composer defaults its project picker to the last conversation's cwd. */
export const lastConversationCwdAtom = userStateFieldAtom("lastConversationCwd", (_before, cwd) => [
	{ type: "lastProject", cwd },
]);
