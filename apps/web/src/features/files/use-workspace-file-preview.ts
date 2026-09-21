import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectFilePreview, ProjectWriteFileResult } from "@ling/contracts/project";
import { lingErrorDtoSchema, type LingErrorDto } from "@ling/contracts/ling-error";
import { formatRequestError } from "@renderer/lib/errors";
import { useCallback, useEffect, useRef, useState } from "react";

export interface FilePreviewOutcome {
	cwd: string;
	path: string;
	refreshRevision: string;
	preview: ProjectFilePreview | null;
	error: string | null;
}

/** A failed refresh keeps the last complete document available, but never borrows another file's content. */
export function failedFilePreview(
	current: FilePreviewOutcome | null,
	target: Pick<FilePreviewOutcome, "cwd" | "path" | "refreshRevision">,
	error: string,
): FilePreviewOutcome {
	return {
		...target,
		preview: current?.cwd === target.cwd && current.path === target.path ? current.preview : null,
		error,
	};
}

interface FileSaveError {
	cwd: string;
	path: string;
	error: LingErrorDto;
}

interface FileSaveActivity {
	id: number;
	cwd: string;
	path: string;
}

export function useWorkspaceFilePreview({
	cwd,
	path,
	open,
	refreshRevision,
}: {
	cwd: string;
	path: string | null;
	open: boolean;
	refreshRevision: string;
}) {
	const hostProjectApi = useDomainApi("project");

	const [outcome, setOutcome] = useState<FilePreviewOutcome | null>(null);
	const [loading, setLoading] = useState(false);
	const [saveActivities, setSaveActivities] = useState<readonly FileSaveActivity[]>([]);
	const [saveFailure, setSaveFailure] = useState<FileSaveError | null>(null);
	const requestIdRef = useRef(0);
	const saveIdRef = useRef(0);
	const mountedRef = useRef(true);
	const outcomeMatches = path !== null && outcome?.cwd === cwd && outcome.path === path;
	const preview = outcomeMatches ? outcome.preview : null;
	const error = outcomeMatches ? outcome.error : null;
	const saving = path !== null && saveActivities.some((activity) => activity.cwd === cwd && activity.path === path);
	const saveError = path !== null && saveFailure?.cwd === cwd && saveFailure.path === path ? saveFailure.error : null;
	// Filesystem changes refresh the disk revision without unmounting the editor or losing its focus.
	const visibleLoading =
		open && path !== null && (loading || !outcomeMatches || outcome.refreshRevision !== refreshRevision);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			requestIdRef.current += 1;
		};
	}, []);

	const load = useCallback(() => {
		if (!open || path === null) return;
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setLoading(true);
		setSaveFailure((current) => (current?.cwd === cwd && current.path === path ? null : current));
		void hostProjectApi
			.readFilePreview({ cwd, path })
			.then((next) => {
				if (!mountedRef.current || requestIdRef.current !== requestId) return;
				setOutcome({ cwd, path, refreshRevision, preview: next, error: null });
			})
			.catch((cause: unknown) => {
				if (!mountedRef.current || requestIdRef.current !== requestId) return;
				setOutcome((current) => failedFilePreview(current, { cwd, path, refreshRevision }, formatRequestError(cause)));
			})
			.finally(() => {
				if (mountedRef.current && requestIdRef.current === requestId) setLoading(false);
			});
	}, [hostProjectApi, cwd, open, path, refreshRevision]);

	const save = useCallback(
		async (content: string, expectedRevision: string): Promise<ProjectWriteFileResult> => {
			if (path === null) throw new Error("No workspace file is selected");
			saveIdRef.current += 1;
			const activity = { id: saveIdRef.current, cwd, path };
			setSaveActivities((current) => [...current, activity]);
			setSaveFailure((current) => (current?.cwd === cwd && current.path === path ? null : current));
			try {
				const result = await hostProjectApi.writeFile({ cwd, path, content, expectedRevision });
				if (mountedRef.current) {
					setOutcome((current) =>
						current?.cwd === cwd &&
						current.path === path &&
						current.preview?.kind === "text" &&
						current.preview.revision === expectedRevision
							? { ...current, preview: { ...current.preview, ...result, content, kind: "text" } }
							: current,
					);
				}
				return result;
			} catch (cause) {
				const candidate =
					typeof cause === "object" && cause !== null && "lingError" in cause ? cause.lingError : undefined;
				const parsed = lingErrorDtoSchema.safeParse(candidate);
				const error: LingErrorDto = parsed.success
					? parsed.data
					: {
							code: "INTERNAL_ERROR",
							category: "runtime",
							message: formatRequestError(cause),
							retryable: false,
							userAction: "report",
						};
				if (mountedRef.current && saveIdRef.current === activity.id) {
					setSaveFailure({ cwd, path, error });
				}
				throw cause;
			} finally {
				if (mountedRef.current) {
					setSaveActivities((current) => current.filter((candidate) => candidate.id !== activity.id));
				}
			}
		},
		[hostProjectApi, cwd, path],
	);

	// refreshRevision intentionally reloads unchanged paths after filesystem updates.
	useEffect(() => {
		if (path === null) {
			requestIdRef.current += 1;
			setOutcome(null);
			setLoading(false);
			setSaveFailure(null);
			return;
		}
		load();
	}, [load, path, refreshRevision]);

	return { preview, error, loading: visibleLoading, reload: load, save, saving, saveError };
}
