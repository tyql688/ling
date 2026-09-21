import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ModelInfo } from "@ling/contracts/session";
import { formatRequestError } from "@renderer/lib/errors";
import { useEffect, useState } from "react";

interface ProjectModelResult {
	requestedCwd: string;
	models: ModelInfo[];
}

/** Effective Pi model catalog for the selected new-session project. The cwd tag
 * prevents a late response from one project appearing under another selection. */
export function useProjectModels(cwd: string | null): {
	models: ModelInfo[] | null;
	/** Display-only snapshot during a folder change; it cannot authorize a new session. */
	pendingCatalog: ProjectModelResult | null;
	error: string | null;
	retry(): void;
} {
	const hostModelsApi = useDomainApi("models");

	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<ProjectModelResult | null>(null);
	const [failure, setFailure] = useState<{ requestedCwd: string; message: string } | null>(null);

	useEffect(() => {
		if (cwd === null) return;
		let cancelled = false;
		let requestRevision = 0;
		const refresh = () => {
			requestRevision += 1;
			const revision = requestRevision;
			void hostModelsApi
				.listProjectModels({ cwd })
				.then((catalog) => {
					if (cancelled || revision !== requestRevision) return;
					setResult({ requestedCwd: cwd, models: catalog.models });
					setFailure(null);
				})
				.catch((cause: unknown) => {
					if (cancelled || revision !== requestRevision) return;
					setResult(null);
					setFailure({ requestedCwd: cwd, message: formatRequestError(cause) });
				});
		};
		refresh();
		const unsubscribe = hostModelsApi.onChanged(refresh);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [hostModelsApi, cwd, attempt]);

	return {
		retry: () => setAttempt((current) => current + 1),
		models: result?.requestedCwd === cwd ? result.models : null,
		pendingCatalog: cwd !== null && result?.requestedCwd !== cwd ? result : null,
		error: failure?.requestedCwd === cwd ? failure.message : null,
	};
}
