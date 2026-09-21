import type { AccessActivation } from "@ling/contracts/permissions";
import { useFeatureSnapshot } from "@renderer/features/companions/use-feature-snapshot";
import { useDomainApi } from "@renderer/lib/host-api-context";

export function useAccessActivation() {
	const api = useDomainApi("permissions");
	return useFeatureSnapshot<AccessActivation>({
		load: () => api.read(),
		subscribe: (refresh) => api.onChanged(refresh),
		key: "permissions",
	});
}
