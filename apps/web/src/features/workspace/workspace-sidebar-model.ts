import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import type { ProjectActionTarget } from "@renderer/features/projects/project-actions-menu";
import { basenameFromPath } from "@renderer/lib/format-path";

export type WorkspaceSidebarProject = ProjectActionTarget & {
	pinned: boolean;
	sessionCount: number;
	latestAt: number;
};

interface WorkspaceSidebarModel {
	projects: WorkspaceSidebarProject[];
	scopedProject: WorkspaceSidebarProject | null;
	activeSessions: SessionSummary[];
	archivedSessions: SessionSummary[];
	projectNameByCwd: ReadonlyMap<string, string>;
}

interface BuildWorkspaceSidebarModelOptions {
	projects: readonly OpenProjectInfo[];
	sessions: readonly SessionSummary[];
	pinnedProjectCwds: readonly string[];
	projectDisplayNames: Readonly<Record<string, string>>;
	projectScopeCwd: string | null;
}

function compareActiveSessions(left: SessionSummary, right: SessionSummary): number {
	const leftPinned = left.pinnedAt;
	const rightPinned = right.pinnedAt;
	if (leftPinned !== undefined && rightPinned !== undefined) return rightPinned - leftPinned;
	if (leftPinned !== undefined) return -1;
	if (rightPinned !== undefined) return 1;

	// The session inbox keeps rows stable while streaming: sort by creation time, not updatedAt,
	// so active rows don't jump around under the pointer.
	return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

function compareArchivedSessions(left: SessionSummary, right: SessionSummary): number {
	return (
		right.updatedAt - left.updatedAt ||
		(right.archivedAt ?? 0) - (left.archivedAt ?? 0) ||
		left.id.localeCompare(right.id)
	);
}

export function buildWorkspaceSidebarModel({
	projects,
	sessions,
	pinnedProjectCwds,
	projectDisplayNames,
	projectScopeCwd,
}: BuildWorkspaceSidebarModelOptions): WorkspaceSidebarModel {
	const topLevelSessions = sessions.filter((session) => session.relation?.kind !== "child");
	const openProjectByCwd = new Map(projects.map((project) => [project.cwd, project]));
	const pinnedOrder = new Map(pinnedProjectCwds.map((cwd, index) => [cwd, index]));
	const latestAtByCwd = new Map<string, number>();
	const sessionCountByCwd = new Map<string, number>();

	for (const session of topLevelSessions) {
		latestAtByCwd.set(session.cwd, Math.max(latestAtByCwd.get(session.cwd) ?? 0, session.updatedAt));
		sessionCountByCwd.set(session.cwd, (sessionCountByCwd.get(session.cwd) ?? 0) + 1);
	}

	const projectOrder = new Map(projects.map((project, index) => [project.cwd, index]));
	const projectCwds = new Set([...projects.map((project) => project.cwd), ...sessionCountByCwd.keys()]);
	const sidebarProjects = [...projectCwds]
		.map<WorkspaceSidebarProject>((cwd) => {
			const openProject = openProjectByCwd.get(cwd);
			const displayName = projectDisplayNames[cwd];
			const target: ProjectActionTarget =
				openProject === undefined
					? {
							project: {
								cwd,
								name: displayName ?? basenameFromPath(cwd),
								meta: { kind: "primary" },
								diagnostics: [],
							},
							projectOpen: false,
						}
					: { project: { ...openProject, name: displayName ?? openProject.name }, projectOpen: true };
			return {
				...target,
				pinned: pinnedOrder.has(cwd),
				sessionCount: sessionCountByCwd.get(cwd) ?? 0,
				latestAt: latestAtByCwd.get(cwd) ?? 0,
			};
		})
		.sort((left, right) => {
			const leftPinned = pinnedOrder.get(left.project.cwd);
			const rightPinned = pinnedOrder.get(right.project.cwd);
			if (leftPinned !== undefined && rightPinned !== undefined) return leftPinned - rightPinned;
			if (leftPinned !== undefined) return -1;
			if (rightPinned !== undefined) return 1;
			if (left.latestAt !== right.latestAt) return right.latestAt - left.latestAt;
			const leftOpenOrder = projectOrder.get(left.project.cwd);
			const rightOpenOrder = projectOrder.get(right.project.cwd);
			if (leftOpenOrder !== undefined && rightOpenOrder !== undefined) return leftOpenOrder - rightOpenOrder;
			if (leftOpenOrder !== undefined) return -1;
			if (rightOpenOrder !== undefined) return 1;
			return left.project.name.localeCompare(right.project.name);
		});

	const scopedProject =
		projectScopeCwd === null ? null : (sidebarProjects.find((entry) => entry.project.cwd === projectScopeCwd) ?? null);
	const visibleSessions =
		scopedProject === null
			? topLevelSessions
			: topLevelSessions.filter((session) => session.cwd === scopedProject.project.cwd);
	const projectNameByCwd = new Map(sidebarProjects.map((entry) => [entry.project.cwd, entry.project.name]));

	return {
		projects: sidebarProjects,
		scopedProject,
		activeSessions: visibleSessions.filter((session) => session.archivedAt === undefined).sort(compareActiveSessions),
		archivedSessions: visibleSessions
			.filter((session) => session.archivedAt !== undefined)
			.sort(compareArchivedSessions),
		projectNameByCwd,
	};
}
