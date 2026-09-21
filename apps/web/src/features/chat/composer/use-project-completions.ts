import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectMentionItem } from "@ling/contracts/project";
import type { SkillInfo } from "@ling/contracts/skill";
import {
	type ComposerCompletionToken,
	mentionTokenAt,
} from "@renderer/features/chat/composer/composer-completion-tokens";
import { basenameFromPath } from "@renderer/lib/format-path";
import { formatRequestError } from "@renderer/lib/errors";
import { useEffect, useMemo, useState } from "react";

interface ProjectMentionCompletionItem {
	name: string;
	displayText: string;
	description: string;
	mentionPath: string;
	kind: "file" | "directory";
	iconPath: string;
}

interface ProjectSkillCompletionItem {
	kind: "skill";
	name: string;
	description: string;
	insertText: string;
}

function toMentionCompletion(item: ProjectMentionItem): ProjectMentionCompletionItem {
	return {
		name: `mention:${item.path}`,
		displayText: item.kind === "directory" ? `${basenameFromPath(item.path)}/` : basenameFromPath(item.path),
		description: `@${item.path}`,
		mentionPath: item.path,
		kind: item.kind,
		iconPath: item.path,
	};
}

/** Debounced @file lookup for the token under the cursor. Pass cwd null to suppress the trigger. */
export function useProjectMentionCompletions({
	cwd,
	text,
	cursorOffset,
}: {
	cwd: string | null;
	text: string;
	cursorOffset: number;
}): {
	token: ComposerCompletionToken | null;
	items: ProjectMentionCompletionItem[];
	loading: boolean;
	error: string | null;
	retry: () => void;
} {
	const hostProjectApi = useDomainApi("project");

	const token = cwd === null ? null : mentionTokenAt(text, cursorOffset);
	const query = token?.query ?? null;
	const [requestRevision, setRequestRevision] = useState(0);
	const [result, setResult] = useState<{
		cwd: string;
		query: string;
		files: ProjectMentionItem[];
		error: string | null;
	} | null>(null);

	useEffect(() => {
		if (cwd === null || query === null) {
			return;
		}
		let cancelled = false;
		// Coalesce keystrokes without letting suggestions from another query or project remain selectable.
		const timer = window.setTimeout(() => {
			void hostProjectApi
				.listFiles({ cwd, query })
				.then((files) => {
					if (!cancelled) setResult({ cwd, query, files, error: null });
				})
				.catch((cause: unknown) => {
					if (!cancelled) setResult({ cwd, query, files: [], error: formatRequestError(cause) });
				});
		}, 120);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [hostProjectApi, cwd, query, requestRevision]);

	const current = result?.cwd === cwd && result.query === query ? result : null;
	const items = useMemo(() => current?.files.map(toMentionCompletion) ?? [], [current]);
	return {
		token,
		items,
		loading: token !== null && current === null,
		error: current?.error ?? null,
		retry: () => {
			setResult(null);
			setRequestRevision((revision) => revision + 1);
		},
	};
}

/** Project skill list for the quick-start slash popover; fetch only once the user actually types "/". */
export function useProjectSkillCompletions({ cwd, enabled }: { cwd: string | null; enabled: boolean }): {
	items: ProjectSkillCompletionItem[];
	loading: boolean;
	error: string | null;
	retry: () => void;
} {
	const hostSkillsApi = useDomainApi("skills");
	const [requestRevision, setRequestRevision] = useState(0);

	const [result, setResult] = useState<{ cwd: string; skills: SkillInfo[]; error: string | null } | null>(null);

	useEffect(() => {
		if (cwd === null || !enabled) {
			return;
		}
		let cancelled = false;
		void hostSkillsApi
			.projectSkills({ cwd })
			.then((skills) => {
				if (!cancelled) setResult({ cwd, skills, error: null });
			})
			.catch((cause: unknown) => {
				if (!cancelled) setResult({ cwd, skills: [], error: formatRequestError(cause) });
			});
		return () => {
			cancelled = true;
		};
	}, [hostSkillsApi, cwd, enabled, requestRevision]);

	const current = enabled && result?.cwd === cwd ? result : null;
	const items = useMemo(
		() =>
			current?.skills.map((skill) => ({
				kind: "skill" as const,
				name: `skill:${skill.name}`,
				description: skill.description,
				insertText: `/skill:${skill.name} `,
			})) ?? [],
		[current],
	);
	return {
		items,
		loading: enabled && cwd !== null && current === null,
		error: current?.error ?? null,
		retry: () => {
			setResult(null);
			setRequestRevision((revision) => revision + 1);
		},
	};
}
