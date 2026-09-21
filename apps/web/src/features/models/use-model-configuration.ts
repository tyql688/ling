import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ModelConfiguration } from "@ling/contracts/model";
import { errorMessage } from "@ling/contracts/ling-error";
import { useEffect, useReducer, useState } from "react";

/** A detail/reference snapshot belongs to its provider, project and model until the dialog closes. */
export function useModelConfiguration(provider: string, modelId: string | null, cwd: string | null) {
	const hostModelsApi = useDomainApi("models");

	const [revision, retry] = useReducer((value: number) => value + 1, 0);
	const identity = JSON.stringify([provider, modelId, cwd, revision]);
	const [result, setResult] = useState<{
		identity: string;
		configuration: ModelConfiguration | null;
		error: string | null;
	} | null>(null);
	useEffect(() => {
		if (modelId === null) return;
		let active = true;
		void hostModelsApi.getConfiguration({ provider, modelId, cwd }).then(
			(configuration) => {
				if (active) setResult({ identity, configuration, error: null });
			},
			(cause: unknown) => {
				if (active) setResult({ identity, configuration: null, error: errorMessage(cause) });
			},
		);
		return () => {
			active = false;
		};
	}, [hostModelsApi, provider, modelId, cwd, identity]);
	const current = result?.identity === identity ? result : null;
	return {
		configuration: current?.configuration ?? null,
		error: current?.error ?? null,
		loading: modelId !== null && current === null,
		retry,
	};
}
