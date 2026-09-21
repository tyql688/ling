import type { BuiltinFeatureId } from "@ling/contracts/builtin-features";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { createContext, useContext, useState } from "react";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useFeatureSnapshot } from "./use-feature-snapshot";

export function useFeatureSettings() {
	const api = useDomainApi("builtinFeatures");
	const state = useFeatureSnapshot({ load: api.read, subscribe: api.onChanged, key: "builtin-features" });
	const [reload, setReload] = useState<PiResourceReloadSummary | null>(null);
	return {
		...state,
		reload,
		setEnabled(id: BuiltinFeatureId, enabled: boolean) {
			if (!state.value) return;
			setReload(null);
			void state.act(() => api.write({ id, enabled, expectedRevision: state.value!.revision }), setReload);
		},
	};
}

export const BuiltinFeaturesContext = createContext<ReturnType<typeof useFeatureSettings> | null>(null);

export function useBuiltinFeatures() {
	const state = useContext(BuiltinFeaturesContext);
	if (!state) throw new Error("Built-in feature settings are unavailable outside the app");
	return state;
}
