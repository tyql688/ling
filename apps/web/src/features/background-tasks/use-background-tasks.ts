import type { BackgroundJob } from "@ling/contracts/background-tasks";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { useFeatureSnapshot } from "@renderer/features/companions/use-feature-snapshot";
import { useDomainApi } from "@renderer/lib/host-api-context";

export function useBackgroundTasks(sessionRef: SessionRef) {
	const api = useDomainApi("backgroundTasks");
	const key = sessionKey(sessionRef);
	return useFeatureSnapshot<BackgroundJob[]>({
		load: () => api.list(sessionRef),
		subscribe: (refresh) => api.onChanged((ref) => (ref === null || sessionKey(ref) === key) && refresh()),
		key,
	});
}
